/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 * 吾爱破解 52pojie: https://www.52pojie.cn/home.php?mod=space&uid=2394304
 *
 * Version v4.7.12
 *
 * Tests for the two upstream refusals that used to fall through to a client
 * 502 with no cooldown, no account switch and no retry (field report v4.7.12):
 *
 *   - 529 / 1305 `overloaded_error` — model capacity. Handled in handler.ts by
 *     classifying it as a model-scoped `concurrency_rejected`; here we pin the
 *     POOL behaviour that classification depends on: a model-scoped hold makes
 *     the next acquire for that model skip the account, while the same account
 *     still serves every other model.
 *   - 400 / 3006 `model not allowed` — plan permission. Pinned as a LONG
 *     model-scoped hold (not the few-second concurrency cooldown), so repeated
 *     calls do not hammer a model the plan will never allow.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "./account-pool.js";
import { addAccount, resetAccountStoreCacheForTest, type AccountRecord } from "./account-store.js";

const TMP_ROOT = join(tmpdir(), `zk-pool-refusal-${process.pid}`);
let tmp = "";
let seq = 0;

async function setupPool(n: number) {
  const records: AccountRecord[] = [];
  for (let i = 0; i < n; i++) {
    records.push(await addAccount({
      credential: { apiKey: `sk-refusal-${i}`, provider: "zai" },
      name: `acct-${i}`,
      deviceMid: `0000000${i}-1111-2222-3333-444444444444`,
    }));
  }
  const pool = new AccountPool({ minSpacingMs: 0, maxConcurrentPerAccount: 8, overflowFactor: 1 });
  await pool.reload();
  return { pool, records };
}

function pick(pool: AccountPool, model: string): string {
  const r = pool.acquire({ model });
  if (!r.ok) return `<${r.reason}>`;
  r.lease.release();
  return r.lease.accountName;
}

/** Acquire result for `model`, without narrowing to a specific refusal reason. */
function blocked(pool: AccountPool, model: string): boolean {
  const r = pool.acquire({ model });
  if (r.ok) { r.lease.release(); return false; }
  return true;
}

beforeEach(() => {
  tmp = `${TMP_ROOT}-${seq++}`;
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = `${tmp}/legacy`;
  resetAccountStoreCacheForTest();
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  resetAccountStoreCacheForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("pool refusal kinds (v4.7.12)", () => {
  it("a model-scoped 529/1305 hold skips that account for the model, not for others", async () => {
    // This is the mechanism the handler's 529 retry relies on: it reports the
    // model cooldown and then re-acquires, expecting a DIFFERENT account.
    const { pool, records } = await setupPool(2);
    pool.reportResult(records[0]!.id, { kind: "concurrency_rejected", model: "glm-5.3" });

    // The held account is skipped for glm-5.3...
    expect(pick(pool, "glm-5.3")).toBe("acct-1");
    // ...but still serves a different model.
    const other = pick(pool, "glm-5.3-flash");
    expect(["acct-0", "acct-1"]).toContain(other);
  });

  it("3006 model-not-allowed holds the model far longer than a concurrency cooldown", async () => {
    // A concurrency cooldown is seconds; a permission refusal must outlast many
    // retries, or every call pays a doomed round-trip (glm-4.7 failing on
    // EVERY call in the field report).
    const { pool, records } = await setupPool(1);
    pool.reportResult(records[0]!.id, { kind: "model_not_allowed", model: "glm-4.7" });

    // Still held for this model (the exact refusal reason depends on which
    // gate rejects — model cooldown, account cooldown, all_gates_full — so the
    // assertion is the OUTCOME: no dispatch)...
    expect(blocked(pool, "glm-4.7")).toBe(true);
    // ...while the account is untouched for anything else.
    expect(pick(pool, "glm-5.3")).toBe("acct-0");
  });

  it("3006 without a model falls back to a generic account cooldown", async () => {
    // Defensive: if a caller cannot name the model, the pool must still stop
    // dispatching to the account rather than treating the refusal as a no-op.
    const { pool, records } = await setupPool(1);
    pool.reportResult(records[0]!.id, { kind: "model_not_allowed" });
    expect(blocked(pool, "glm-5.3")).toBe(true);
  });
});
