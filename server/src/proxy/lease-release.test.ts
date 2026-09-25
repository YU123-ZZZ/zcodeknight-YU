/**
 * Concurrency-lease release on every exit path.
 *
 * The lease is acquired in `proxyRequest` before the body is translated, and
 * `inFlight` is ONLY decremented by `lease.release()`. Several early returns sat
 * between acquisition and the normal release points and simply returned:
 *
 *   - `handler.ts` — the two OpenAI/Anthropic translation failures
 *   - `responses-handler.ts` — upstream error, connect failure, non-JSON body
 *     (both branches), and a stream with no body
 *
 * Measured consequence: three malformed OpenAI bodies left `inFlight` at 3 with
 * the gate at 2, so that account never dispatched again for the life of the
 * process. A malformed body is the most common client error there is, so this
 * was reachable by any client that sent one bad request twice.
 *
 * The existing pool tests cover the acquire/release CONTRACT
 * (auth/pool-quota.test.ts) but drive the pool directly, so they could never see
 * a leak that lives in the request path. These tests go through `proxyRequest`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultAccountPool } from "../auth/account-pool.js";
import { addAccount, resetAccountStoreCacheForTest } from "../auth/account-store.js";
import { MultiAuthManager } from "../auth/multi-auth-manager.js";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig } from "../config/types.js";

let tmp = "";
let seq = 0;

beforeEach(async () => {
  tmp = join(tmpdir(), `zk-lease-${process.pid}-${seq++}`);
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(tmp, "legacy");
  resetAccountStoreCacheForTest();
  await addAccount({
    credential: { apiKey: "sk-lease", provider: "zai" },
    name: "acct-lease",
    deviceMid: "0000000a-1111-2222-3333-444444444444",
  });
  const pool = getDefaultAccountPool();
  await pool.reload();
  // Spacing off, so the ONLY thing that can refuse a later dispatch is the gate
  // — which is the state under test. Otherwise the assertion would pass because
  // of the 1.5s spacing window rather than because no slot leaked.
  pool.updateOptions({ minSpacingMs: 0, maxConcurrentPerAccount: 2 });
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  resetAccountStoreCacheForTest();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function testConfig(): ProxyConfig {
  return {
    server: { port: 1, host: "127.0.0.1" },
    auth: { proxyApiKey: "k" },
    provider: "zai",
    plan: "start-plan",
    providers: {
      zai: { anthropicBase: "https://a.invalid", openaiBase: "https://o.invalid" },
      bigmodel: { anthropicBase: "https://b.invalid", openaiBase: "https://b.invalid" },
    },
    defaultModel: "glm-5.3",
    models: ["glm-5.3"],
    identity: {
      appVersion: "3.14.1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai",
      deviceMid: "00000000-0000-0000-0000-000000000000",
    },
    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1 },
    responses: { enabled: true, storeMaxEntries: 1, storeTtlMs: 1 },
    endpointRouting: { enabled: false, origin: "" },
    clientSigning: { enabled: false, origin: "" },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false },
    async: {
      enabled: false, origin: "", pollIntervalMs: 1, keepaliveIntervalMs: 1,
      maxWaitMs: 0, maxRetries: 0, settleTimeoutMs: 1, controlTimeoutMs: 1, defaultModel: "",
    },
    claim: { enabled: false, auto: false, origin: "", pollIntervalMs: 1, cooldownMs: 1, planId: "" },
    probe: {
      enabled: false, auto: false, startupDelayMs: 1, intervalMs: 1, timeoutMs: 100, gapMs: 0, accountPauseMs: 0,
    },
    logging: { level: "error" },
  } as ProxyConfig;
}

/** The pool's view of how many slots this account is holding. */
function inFlight(): number {
  return getDefaultAccountPool().snapshot()[0]!.inFlight;
}

/** A request the OpenAI→Anthropic translator rejects (malformed JSON body). */
function malformedOpenAI(): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
}

describe("a rejected request does not burn a concurrency slot", () => {
  it("releases the lease when the OpenAI body fails to translate", async () => {
    const auth = new MultiAuthManager(getDefaultAccountPool());
    for (let i = 0; i < 5; i++) {
      const resp = await proxyRequest(malformedOpenAI(), "openai", { config: testConfig(), auth });
      expect(resp.status).toBe(400);
    }
    // The regression: this used to climb with every bad request and never come
    // back down.
    expect(inFlight()).toBe(0);
  });

  it("leaves the account dispatchable after a burst of bad requests", async () => {
    // The consequence that matters: with the gate at 2, two leaks retire the
    // account for the life of the process.
    const auth = new MultiAuthManager(getDefaultAccountPool());
    for (let i = 0; i < 20; i++) {
      await proxyRequest(malformedOpenAI(), "openai", { config: testConfig(), auth });
    }
    const got = getDefaultAccountPool().acquire({ model: "glm-5.3" });
    expect(got.ok).toBe(true);
    if (got.ok) got.lease.release();
  });

  it("releases the lease when the upstream is unreachable", async () => {
    // A connect failure is the other early-return path on this route; it takes
    // a different branch (502) but must release just the same.
    const auth = new MultiAuthManager(getDefaultAccountPool());
    const cfg = testConfig();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
    });
    // No fetch stub: the configured base is an `.invalid` host, so the connect
    // fails for real.
    const resp = await proxyRequest(req, "openai", { config: cfg, auth });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(inFlight()).toBe(0);
  });
});

describe("the per-account request counter counts each request once", () => {
  it("does not double-count a successful dispatch", async () => {
    // `makeLease` increments stats.requests on every dispatch, and `touch()`
    // incremented it again on success — so every successful request read as two,
    // and a healthy account's card showed a 50% success rate.
    const pool = getDefaultAccountPool();
    const id = pool.snapshot()[0]!.id;
    const before = pool.snapshot()[0]!.stats.requests;

    // One lease + the success path that follows it.
    const got = pool.acquire({ model: "glm-5.3" });
    expect(got.ok).toBe(true);
    if (got.ok) got.lease.release();
    await pool.touch(id);

    const after = pool.snapshot()[0]!.stats.requests;
    expect(after - before).toBe(1);
  });
});
