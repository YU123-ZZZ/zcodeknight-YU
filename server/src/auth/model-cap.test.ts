/**
 * Per-model concurrency gate: glm-5.3 cap=1 means a second simultaneous
 * acquire on ONE account must be refused for that model while another
 * account's slot is offered instead (or a queue-refusal when none left).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "./account-pool.js";
import { addAccount, resetAccountStoreCacheForTest } from "./account-store.js";

const TMP_ROOT = join(tmpdir(), `zk-model-cap-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(async () => {
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

describe("per-model gate", () => {
  it("glm-5.3 second concurrent acquire on same account is refused", async () => {
    await addAccount({ credential: { apiKey: "sk-0", provider: "zai" }, name: "a0" });
    const pool = new AccountPool({
      minSpacingMs: 0,
      maxConcurrentPerAccount: 4,
      maxConcurrentPerModel: { default: 3, byModel: { "glm-5.3": 1 } },
    });
    await pool.reload();
    const r1 = pool.acquire({ model: "glm-5.3" });
    expect(r1.ok).toBe(true);
    const r2 = pool.acquire({ model: "glm-5.3" });
    // cap=1: no account has a free glm-5.3 slot; strict (overflow 1) refuses.
    expect(r2.ok).toBe(false);
    r1.lease.release();
    const r3 = pool.acquire({ model: "glm-5.3" });
    expect(r3.ok).toBe(true);
    r3.lease.release();
  });

  it("second glm-5.3 goes to a DIFFERENT account, never stacked", async () => {
    for (const n of ["a0", "a1"]) {
      await addAccount({ credential: { apiKey: `sk-${n}`, provider: "zai" }, name: n });
    }
    const pool = new AccountPool({
      minSpacingMs: 0,
      maxConcurrentPerAccount: 4,
      maxConcurrentPerModel: { default: 3, byModel: { "glm-5.3": 1 } },
    });
    await pool.reload();
    const r1 = pool.acquire({ model: "glm-5.3" });
    const r2 = pool.acquire({ model: "glm-5.3" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.lease.accountName).not.toBe(r1.lease.accountName);
  });
});
