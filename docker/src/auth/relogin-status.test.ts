/**
 * Sticky "needs re-login" status.
 *
 * An account whose credential upstream has rejected (401/403) must stay
 * visibly broken until something actually fixes the credential. The status
 * field alone could not express that, because every transient transition
 * overwrote it:
 *
 *   - `reload()` runs after EVERY account edit (rename, plan toggle, note, a
 *     sibling's deletion, a backup restore) and used to reset the mark
 *     unconditionally — so touching the panel repainted a dead account as 正常;
 *   - `setPaused(id, false)` (the 启用 button) wrote `ok` outright, so
 *     pause→resume laundered the mark;
 *   - `clearCooldown` (the 清除冷却 button) did the same;
 *   - the relogin cooldown itself expired into 冷却中 and then 正常.
 *
 * The fix is a sticky `reloginRequired` flag that only a credential rotation
 * or a proven-successful upstream call clears. These tests pin that contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "./account-pool.js";
import {
  addAccount,
  deleteAccount,
  loadAccounts,
  resetAccountStoreCacheForTest,
  updateAccount,
} from "./account-store.js";

const TMP_ROOT = join(tmpdir(), `zk-relogin-${process.pid}`);
let tmp = "";
let seq = 0;

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

/** One account with a JWT (start-plan shape) and a pool that has loaded it. */
async function setup() {
  const record = await addAccount({
    credential: { apiKey: "sk-1", provider: "zai", jwt: "header.payload.sig" },
    name: "acct-1",
    deviceMid: "00000001-1111-2222-3333-444444444444",
  });
  const pool = new AccountPool({ minSpacingMs: 0 });
  await pool.reload();
  return { pool, record };
}

const statusOf = (pool: AccountPool, id: string) => pool.snapshot().find((s) => s.id === id)!.status;

describe("relogin mark survives unrelated panel activity", () => {
  it("survives a rename (reload after /accounts/update)", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });
    expect(statusOf(pool, record.id)).toBe("relogin");

    // What POST /accounts/update does: write the new name, then reload.
    await updateAccount(record.id, { name: "renamed" });
    await pool.reload();

    expect(statusOf(pool, record.id)).toBe("relogin");
    expect(pool.snapshot().find((s) => s.id === record.id)!.statusNote).toContain("re-login");
  });

  it("survives a plan toggle, a note edit and a sibling's deletion", async () => {
    const { pool, record } = await setup();
    const other = await addAccount({
      credential: { apiKey: "sk-2", provider: "zai", jwt: "h.p.s" },
      name: "acct-2",
      deviceMid: "00000002-1111-2222-3333-444444444444",
    });
    await pool.reload();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    await updateAccount(record.id, { plan: "coding-plan", note: "touched" });
    await deleteAccount(other.id);
    await pool.reload();

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("survives pause then resume (the 启用 button)", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    pool.setPaused(record.id, true);
    expect(statusOf(pool, record.id)).toBe("paused");
    pool.setPaused(record.id, false);

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("survives clearCooldown (the 清除冷却 button)", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    pool.clearCooldown(record.id);

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("does not decay to 冷却中 once the relogin cooldown expires", async () => {
    // A relogin also applies a cooldown, but the credential is still dead after
    // it lapses — reporting 冷却中 (and then 正常) would be a lie about the cause.
    const record = await addAccount({
      credential: { apiKey: "sk-1", provider: "zai", jwt: "h.p.s" },
      name: "acct-1",
      deviceMid: "00000001-1111-2222-3333-444444444444",
    });
    const pool = new AccountPool({ minSpacingMs: 0, reloginCooldownMs: 1 });
    await pool.reload();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    await new Promise((r) => setTimeout(r, 10));

    expect(statusOf(pool, record.id)).toBe("relogin");
    // And it stays out of the dispatch set, so a dead account cannot be picked.
    expect(pool.acquire({}).ok).toBe(false);
  });
});

describe("only real evidence clears the mark", () => {
  it("a credential rotation clears it", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    // Re-login: same account id, new JWT (the field a login actually rotates).
    await updateAccount(record.id, {
      credential: { apiKey: "sk-1", provider: "zai", jwt: "new.jwt.sig" },
    });
    await pool.reload();

    expect(statusOf(pool, record.id)).toBe("ok");
  });

  it("a metadata-only edit with the same credential does NOT clear it", async () => {
    // The precise bug: reload used to clear on every call. Same credential in,
    // same verdict out.
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    await updateAccount(record.id, { name: "still-the-same-token", note: "note" });
    await pool.reload();

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("a successful dispatch clears it", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });
    expect(pool.acquire({}).ok).toBe(false);

    pool.reportResult(record.id, { kind: "success" });

    expect(statusOf(pool, record.id)).toBe("ok");
    expect(pool.acquire({}).ok).toBe(true);
  });

  it("a successful out-of-band check clears it, and a rejection re-marks it", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    // The balance poller read billing/balance with this JWT and got an answer.
    pool.reportAuthOk(record.id);
    expect(statusOf(pool, record.id)).toBe("ok");

    // Next poll: the gateway rejected it. Back to 需重登 without any request.
    pool.reportAuthRejected(record.id);
    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("a transient error does not clear the mark", async () => {
    // `error` is the catch-all for a 5xx/network failure. It is not evidence the
    // credential works, so it must not launder the mark.
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("cooldown and exhaustion do not clear the mark either", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    pool.reportResult(record.id, { kind: "concurrency_rejected" });
    pool.reportResult(record.id, { kind: "quota_exhausted" });

    expect(statusOf(pool, record.id)).toBe("relogin");
  });

  it("reporting on an unknown account is a no-op, not a resurrection", async () => {
    const { pool } = await setup();
    expect(pool.reportAuthRejected("no-such-id")).toBe(false);
    expect(pool.reportAuthOk("no-such-id")).toBe(false);
    expect(pool.snapshot()).toHaveLength(1);
  });
});

describe("a dead account is excluded from dispatch", () => {
  it("is skipped while a healthy sibling keeps serving", async () => {
    const { pool, record } = await setup();
    const healthy = await addAccount({
      credential: { apiKey: "sk-2", provider: "zai" },
      name: "healthy",
      deviceMid: "00000002-1111-2222-3333-444444444444",
    });
    await pool.reload();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    // Every dispatch goes to the healthy account, never the marked one.
    for (let i = 0; i < 4; i++) {
      const r = pool.acquire({});
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.lease.accountId).toBe(healthy.id);
        r.lease.release();
      }
    }
    // listEligible drives the chat account picker, so it must agree.
    expect(pool.listEligible().map((a) => a.id)).toEqual([healthy.id]);
  });
});

describe("the mark is persisted only in memory, not in the store", () => {
  it("leaves the on-disk record untouched", async () => {
    // The mark is runtime state derived from observed failures; writing it to
    // the store would make it survive a restart that should re-probe.
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "auth_rejected" });

    const doc = await loadAccounts();
    expect(doc.accounts).toHaveLength(1);
    expect(Object.keys(doc.accounts[0]!)).not.toContain("reloginRequired");
    expect(doc.accounts[0]!.credential.jwt).toBe("header.payload.sig");
  });
});

/**
 * An upstream error must change the badge, not just the note.
 *
 * `case "error"` used to set only `statusNote`, so an account whose requests
 * were failing with 5xx still rendered as a green 正常 with the reason in small
 * grey text underneath — invisible to anyone scanning the status column, which
 * is what the column exists for.
 */
describe("a failing account does not read as 正常", () => {
  it("reports error after an upstream failure", async () => {
    const { pool, record } = await setup();
    expect(statusOf(pool, record.id)).toBe("ok");

    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });

    expect(statusOf(pool, record.id)).toBe("error");
    expect(pool.snapshot().find((s) => s.id === record.id)!.statusNote).toContain("502");
  });

  it("a success clears it immediately", async () => {
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });
    expect(statusOf(pool, record.id)).toBe("error");

    pool.reportResult(record.id, { kind: "success" });

    expect(statusOf(pool, record.id)).toBe("ok");
  });

  it("an error does NOT bench the account", async () => {
    // A single 502 says nothing about the next request, so taking the account
    // out of rotation on it would drop a healthy account for no reason.
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });

    const lease = pool.acquire({});
    expect(lease.ok).toBe(true);
    if (lease.ok) lease.lease.release();
  });

  it("a specific diagnosis outranks the generic error", async () => {
    // error is "it failed and we do not know why"; these are known causes and
    // must keep their own badge and colour.
    const { pool, record } = await setup();
    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });

    pool.reportResult(record.id, { kind: "quota_exhausted" });
    expect(statusOf(pool, record.id)).toBe("exhausted");
  });

  it("the error mark lapses on its own", async () => {
    // Time alone heals it, so an account that goes quiet after one blip does not
    // stay marked 异常 forever.
    const record = await addAccount({
      credential: { apiKey: "sk-1", provider: "zai", jwt: "h.p.s" },
      name: "acct-1",
      deviceMid: "00000001-1111-2222-3333-444444444444",
    });
    let fakeNow = 1_700_000_000_000;
    const pool = new AccountPool({ minSpacingMs: 0, now: () => fakeNow });
    await pool.reload();
    pool.reportResult(record.id, { kind: "error", message: "upstream 502" });
    expect(statusOf(pool, record.id)).toBe("error");

    fakeNow += 2 * 60_000 + 1;

    expect(statusOf(pool, record.id)).toBe("ok");
  });
});

/**
 * Pause is PERSISTED, unlike the relogin mark next door.
 *
 * The two look similar and are deliberately different: a relogin mark is
 * evidence about the credential, which only a rotation or a live success may
 * clear, so it is kept out of the store. A pause is an instruction from the
 * operator ("leave this account alone"), and an instruction that evaporates on
 * restart is not an instruction.
 *
 * It used to live only in the pool's runtime object, so every engine restart
 * silently resumed every paused account — an operator sees that as "my pauses
 * turned themselves off", with nothing on screen to explain why.
 */
describe("pause survives a restart", () => {
  it("a paused account is still paused in a fresh pool", async () => {
    const record = await addAccount({
      credential: { apiKey: "sk-p", provider: "zai" },
      name: "acct-p",
      deviceMid: "0000000f-1111-2222-3333-444444444444",
    });

    const pool = new AccountPool({ minSpacingMs: 0 });
    await pool.reload();
    expect(pool.setPaused(record.id, true)).toBe(true);
    expect(statusOf(pool, record.id)).toBe("paused");

    // The panel persists it on the same click; here we do that step directly and
    // then stand up a NEW pool, which is what an engine restart looks like.
    await updateAccount(record.id, { paused: true });
    const afterRestart = new AccountPool({ minSpacingMs: 0 });
    await afterRestart.reload();
    expect(statusOf(afterRestart, record.id)).toBe("paused");
  });

  it("resuming is persisted too, so a restart does not re-pause it", async () => {
    const record = await addAccount({
      credential: { apiKey: "sk-q", provider: "zai" },
      name: "acct-q",
      deviceMid: "0000000e-1111-2222-3333-444444444444",
      // A record that arrives already paused, as an imported store would.
    });
    await updateAccount(record.id, { paused: true });
    await updateAccount(record.id, { paused: false });

    const afterRestart = new AccountPool({ minSpacingMs: 0 });
    await afterRestart.reload();
    expect(statusOf(afterRestart, record.id)).toBe("ok");
  });

  it("a paused account is excluded from dispatch on both sides of a restart", async () => {
    // The point of the flag: it must actually keep the account out of rotation,
    // not merely render a badge.
    const record = await addAccount({
      credential: { apiKey: "sk-r", provider: "zai" },
      name: "acct-r",
      deviceMid: "0000000d-1111-2222-3333-444444444444",
    });
    await updateAccount(record.id, { paused: true });
    const pool = new AccountPool({ minSpacingMs: 0, maxConcurrentPerAccount: 8 });
    await pool.reload();

    const got = pool.acquire({ model: "glm-5.3" });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("all_paused");
  });
});
