/**
 * Reconciliation must not eject live accounts on a partial store read.
 *
 * Field report E1/E2: `reload()` deletes every runtime whose id is absent from
 * the loaded doc, and a failed decrypt/parse returns a PARTIAL doc. One bad
 * read therefore dropped accounts from the pool, and the next good read brought
 * them back — the panel showed an account "sometimes there, sometimes not".
 *
 * The contract pinned here: with a recorded load problem, reload keeps every
 * existing runtime (and annotates why), instead of reconciling against a doc it
 * knows is incomplete.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "./account-pool.js";
import {
  addAccount,
  clearAccountStoreLoadProblemForTest,
  resetAccountStoreCacheForTest,
  setStoreLockedProblemForTest,
} from "./account-store.js";

const TMP_ROOT = join(tmpdir(), `zk-pool-recon-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(() => {
  tmp = `${TMP_ROOT}-${seq++}`;
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = `${tmp}/legacy`;
  resetAccountStoreCacheForTest();
  clearAccountStoreLoadProblemForTest();
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  clearAccountStoreLoadProblemForTest();
  resetAccountStoreCacheForTest();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("account pool reconciliation under a partial store read", () => {
  it("keeps runtimes and annotates them when the load problem is recorded", async () => {
    const a = await addAccount({
      credential: { apiKey: "sk-keep-1", provider: "zai" },
      name: "keep-1",
      deviceMid: "0000000a-1111-2222-3333-444444444444",
    });
    const b = await addAccount({
      credential: { apiKey: "sk-keep-2", provider: "zai" },
      name: "keep-2",
      deviceMid: "0000000b-1111-2222-3333-444444444444",
    });
    const pool = new AccountPool({ minSpacingMs: 0, maxConcurrentPerAccount: 8 });
    await pool.reload();
    expect(pool.snapshot().length).toBe(2);

    // Simulate the dangerous read: a recorded problem + a doc that no longer
    // mentions the accounts (the partial/empty shape a failed decrypt yields).
    setStoreLockedProblemForTest(join(tmp, "accounts.json"));
    const ghostDoc = JSON.stringify({ version: 1, accounts: [] });

    const { loadAccounts } = await import("./account-store.js");
    const real = await loadAccounts();
    (real as { accounts: unknown[] }).accounts = [];
    // Force the pool to see the emptied doc.
    const reloaded = await pool.reload();
    expect(reloaded).toBe(2); // nothing ejected
    const snap = pool.snapshot();
    expect(snap.map((s) => s.name).sort()).toEqual(["keep-1", "keep-2"]);
    // And the reason is visible, not silent.
    expect(snap.every((s) => /账号库加载异常/.test(s.statusNote ?? ""))).toBe(true);
    void ghostDoc;
    void a; void b;
  });
});
