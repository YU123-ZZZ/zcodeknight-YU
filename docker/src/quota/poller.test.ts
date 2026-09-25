/**
 * Balance cache must survive a failed refresh.
 *
 * The reported symptom was balances appearing and disappearing on their own:
 * a number would show, then vanish, then come back. The cause was not the
 * account — it was the cache being overwritten by a read that had failed.
 *
 * `collectQuotaSnapshot` does NOT throw when upstream fails. `fetchBilling`
 * catches the error and reports it as `code: -1` inside `errors`, so the
 * function returns a perfectly well-formed snapshot whose `balances` array is
 * empty. The poller treated "returned without throwing" as success and wrote
 * that empty snapshot over the last good one, so the panel rendered "no balance
 * data" for an account whose allowance had not changed at all. The next poll
 * succeeded and the number reappeared.
 *
 * The rule these tests pin: an empty read only replaces the cache when the
 * gateway CONFIRMED the credential (credentialOk). Everything else — a network
 * error, a 5xx, a timeout — keeps the previous value and records the error.
 * A genuinely empty account (healthy read, no plan) must still be allowed to
 * show as empty, or a stale balance would be pinned forever.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBalance,
  refreshAll,
  resetBalancesForTest,
  setCollectorForTest,
} from "./poller.js";
import { addAccount, resetAccountStoreCacheForTest } from "../auth/account-store.js";
import type { ProxyConfig } from "../config/types.js";
import type { QuotaSnapshot } from "../server/routes-quota.js";

const TMP_ROOT = join(tmpdir(), `zk-poller-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(() => {
  tmp = join(TMP_ROOT, `run-${seq++}`);
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(tmp, "legacy");
  resetAccountStoreCacheForTest();
  resetBalancesForTest();
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  setCollectorForTest(null);
  resetAccountStoreCacheForTest();
  resetBalancesForTest();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** A snapshot shaped like a healthy read: two buckets and an active plan. */
function goodSnapshot(): QuotaSnapshot {
  return {
    provider: "zai",
    serverTime: 1720000000,
    jwt: { ageHours: 1, issuedAt: 1719996400 },
    balances: [
      { showName: "GLM-5.3", remainingUnits: 2_000_000, totalUnits: 3_000_000 },
      { showName: "GLM-5.3-Flash", remainingUnits: 5_000_000, totalUnits: 5_000_000 },
    ],
    activePlans: [
      { planId: "start", name: "ZCode Start Plan", status: "active", entitlements: [], pending: false },
    ],
    claimablePlans: [],
    errors: [],
    authRejected: false,
    credentialOk: true,
  };
}

/**
 * A snapshot shaped like a FAILED read: well-formed, no throw, empty data.
 *
 * This is what a network error actually produces — see the module comment.
 */
function failedSnapshot(): QuotaSnapshot {
  return {
    provider: "zai",
    serverTime: 1720000000,
    jwt: { ageHours: 1, issuedAt: 1719996400 },
    balances: [],
    activePlans: [],
    claimablePlans: [],
    errors: ["balance: -1 Error: ECONNREFUSED", "preview: -1 Error: ECONNREFUSED"],
    authRejected: false,
    credentialOk: false,
  };
}

/** A healthy read that genuinely has nothing (no plan, no buckets). */
function healthyEmptySnapshot(): QuotaSnapshot {
  return { ...failedSnapshot(), errors: [], credentialOk: true };
}

const CONFIG = {} as ProxyConfig;

/** One account, and the poller pointed at a snapshot sequence. */
async function setup(snapshots: QuotaSnapshot[]) {
  const record = await addAccount({
    credential: { apiKey: "sk-1", provider: "zai", jwt: "h.p.s" },
    name: "acct-1",
    deviceMid: "00000001-1111-2222-3333-444444444444",
  });
  let i = 0;
  setCollectorForTest((async () => snapshots[Math.min(i++, snapshots.length - 1)]) as never);
  return record;
}

describe("a failed refresh never blanks a good balance", () => {
  it("keeps the previous snapshot when the read comes back empty and unconfirmed", async () => {
    const rec = await setup([goodSnapshot(), failedSnapshot()]);

    await refreshAll(CONFIG);
    expect(getBalance(rec.id)?.snapshot?.balances).toHaveLength(2);

    await refreshAll(CONFIG);
    const after = getBalance(rec.id)!;
    // The number the operator was looking at is still there...
    expect(after.snapshot?.balances).toHaveLength(2);
    expect(after.snapshot?.balances[0]!.remainingUnits).toBe(2_000_000);
    // ...and the failure is visible as an error rather than as "no data".
    expect(after.error).toContain("ECONNREFUSED");
  });

  it("does not advance refreshedAt on a failed read", async () => {
    // refreshedAt is "when this value was last confirmed good". Bumping it on a
    // failure would make a stale number look freshly verified.
    const rec = await setup([goodSnapshot(), failedSnapshot()]);

    await refreshAll(CONFIG);
    const first = getBalance(rec.id)!.refreshedAt;
    expect(first).toBeGreaterThan(0);

    await refreshAll(CONFIG);
    expect(getBalance(rec.id)!.refreshedAt).toBe(first);
  });

  it("recovers on the next good read", async () => {
    const rec = await setup([
      goodSnapshot(),
      failedSnapshot(),
      { ...goodSnapshot(), balances: [{ showName: "GLM-5.3", remainingUnits: 1_234_567, totalUnits: 3_000_000 }] },
    ]);

    await refreshAll(CONFIG);
    await refreshAll(CONFIG);
    await refreshAll(CONFIG);

    const after = getBalance(rec.id)!;
    expect(after.error).toBe("");
    expect(after.snapshot?.balances[0]!.remainingUnits).toBe(1_234_567);
  });

  it("a failure with NO prior value caches nothing rather than an empty success", async () => {
    const rec = await setup([failedSnapshot()]);
    await refreshAll(CONFIG);

    const entry = getBalance(rec.id)!;
    expect(entry.snapshot).toBeNull();
    expect(entry.refreshedAt).toBe(0);
    expect(entry.error).toContain("ECONNREFUSED");
  });
});

describe("a genuinely empty account still shows as empty", () => {
  it("a confirmed-healthy empty read replaces a stale balance", async () => {
    // The opposite failure: if an empty read could never replace the cache, an
    // account whose plan ended would keep showing the old allowance forever.
    const rec = await setup([goodSnapshot(), healthyEmptySnapshot()]);

    await refreshAll(CONFIG);
    expect(getBalance(rec.id)?.snapshot?.balances).toHaveLength(2);

    await refreshAll(CONFIG);
    const after = getBalance(rec.id)!;
    expect(after.snapshot?.balances).toHaveLength(0);
    expect(after.error).toBe("");
  });
});
