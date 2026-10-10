/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 * 吾爱破解 52pojie: https://www.52pojie.cn/home.php?mod=space&uid=2394304
 * 交流群: 1091692024 — https://qm.qq.com/q/sUAFJgC3Fm
 *
 * Version v4.7.12
 *
 * End-to-end handler tests for the two upstream refusals that used to reach the
 * client as a bare `502 translation_failed` with the raw upstream envelope
 * inside (field report v4.7.12):
 *
 *   - 529 / 1305 `overloaded_error` — model capacity. Must NOT be a 502: the
 *     handler cools the model, re-acquires a DIFFERENT account and retries once,
 *     so a request that a spare account can serve is served.
 *   - 400 / 3006 `model not allowed` — plan permission. Must be a 400 naming
 *     the model, and the model must be held so the next call does not repeat the
 *     doomed round-trip.
 *
 * Two accounts are required: with one, the 529 retry's acquire finds nothing
 * dispatchable and the test would silently measure the fallback instead of the
 * recovery.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultAccountPool, setDefaultAccountPoolForTest, AccountPool } from "../auth/account-pool.js";
import { addAccount, resetAccountStoreCacheForTest } from "../auth/account-store.js";
import { MultiAuthManager } from "../auth/multi-auth-manager.js";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig } from "../config/types.js";

// The success path calls auth.touch(), which persists lastUsedAt. When a test's
// temp store dir is removed in afterEach, that queued write fails and — with the
// default 10s/30s backoff — blocks the NEXT test's addAccount on the serialized
// write chain, so a later test times out for reasons unrelated to what it
// measures. Same remedy the store's own suite uses: no backoff in tests.
process.env.ZCODE_STORE_RETRY_MS = "0,0";

let tmp = "";
let seq = 0;

async function setupTwoAccounts(): Promise<AccountPool> {
  for (let i = 0; i < 2; i++) {
    await addAccount({
      credential: { apiKey: `sk-refuse-${i}`, provider: "zai" },
      name: `acct-${i}`,
      deviceMid: `0000000${i}-1111-2222-3333-444444444444`,
    });
  }
  const pool = new AccountPool({ minSpacingMs: 0, maxConcurrentPerAccount: 4, overflowFactor: 1 });
  await pool.reload();
  // The singleton is what the handler's reportOutcomeToPool / acquire consult.
  setDefaultAccountPoolForTest(pool);
  return pool;
}

function testConfig(): ProxyConfig {
  return {
    server: { port: 1, host: "127.0.0.1" },
    auth: { proxyApiKey: "k" },
    provider: "zai",
    plan: "coding-plan",
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

function chatReq(model = "glm-5.3"): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_refuse",
  type: "message",
  role: "assistant",
  model: "glm-5.3",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

beforeEach(async () => {
  tmp = join(tmpdir(), `zk-refuse-${process.pid}-${seq++}`);
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(tmp, "legacy");
  resetAccountStoreCacheForTest();
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  resetAccountStoreCacheForTest();
  setDefaultAccountPoolForTest(null);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});
describe("529/1305 overloaded is retried on another account, not surfaced as 502", () => {
  it("serves the request when the spare account succeeds", async () => {
    await setupTwoAccounts();
    const auth = new MultiAuthManager(getDefaultAccountPool());
    let calls = 0;
    const seenAccounts: (string | undefined)[] = [];
    const fetchMock = (async (req: Request): Promise<Response> => {
      calls += 1;
      seenAccounts.push(req.headers.get("authorization") ?? undefined);
      if (calls === 1) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", code: "1305", message: "[1305] 该模型当前访问量过大" } }),
          { status: 529, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(ANTHROPIC_OK, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(chatReq(), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });

    expect(calls).toBe(2);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("ok");
    // The retry must have used a DIFFERENT credential — that is the whole point
    // of cooling the model before re-acquiring.
    expect(seenAccounts[0]).not.toBe(seenAccounts[1]);
  });

  it("still answers 429 (retryable), never 502, when both attempts overload", async () => {
    await setupTwoAccounts();
    const auth = new MultiAuthManager(getDefaultAccountPool());
    const fetchMock = (async (): Promise<Response> => new Response(
      JSON.stringify({ type: "error", error: { type: "overloaded_error", code: "1305" } }),
      { status: 529, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

    const resp = await proxyRequest(chatReq(), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });

    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBe("5");
    const body = await resp.json();
    expect(body.error.type).toBe("rate_limited");
    expect(JSON.stringify(body)).not.toContain("translation_failed");
    expect(JSON.stringify(body)).not.toContain("overloaded_error");
  });

  it("prefers the 400 when the spare account answers 3006 instead of 529", async () => {
    // Edge case: the first account is overloaded, the second says the model is
    // not in its plan. The permission answer is the more specific truth and must
    // win — a 429 "retry shortly" would be a lie for a model the plan never
    // allows.
    await setupTwoAccounts();
    const auth = new MultiAuthManager(getDefaultAccountPool());
    let calls = 0;
    const fetchMock = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", code: "1305" } }),
          { status: 529, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ code: 3006, msg: "model not allowed" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(chatReq("glm-4.7"), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });

    expect(calls).toBe(2);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("model_not_allowed");
  });
});

describe("3006 model not allowed is a 400 with a real explanation, not a 502", () => {
  it("names the model and holds it for the next call", async () => {
    const pool = await setupTwoAccounts();
    const auth = new MultiAuthManager(getDefaultAccountPool());
    let calls = 0;
    const fetchMock = (async (): Promise<Response> => {
      calls += 1;
      return new Response(
        JSON.stringify({ code: 3006, msg: "model not allowed" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const resp = await proxyRequest(chatReq("glm-4.7"), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("model_not_allowed");
    expect(body.error.message).toContain("glm-4.7");
    expect(JSON.stringify(body)).not.toContain("translation_failed");

    // Each account pays the 3006 at most ONCE: the hold is model-scoped, so the
    // refusal walks the pool one account at a time and then stops. With two
    // accounts the second call still dispatches (to the other account)...
    const afterFirst = calls;
    const again = await proxyRequest(chatReq("glm-4.7"), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });
    expect(again.status).toBe(400);
    expect(calls).toBeGreaterThan(afterFirst);

    // ...but once BOTH have been told, an immediate third call dispatches
    // nothing — no repeated doomed round-trips against upstream.
    const beforeThird = calls;
    const third = await proxyRequest(chatReq("glm-4.7"), "openai", { config: testConfig(), auth, fetchImpl: fetchMock });
    expect(third.status).toBeGreaterThanOrEqual(400);
    expect(calls).toBe(beforeThird);

    // ...while the accounts still serve a different model.
    const got = pool.acquire({ model: "glm-5.3" });
    expect(got.ok).toBe(true);
    if (got.ok) got.lease.release();
  });
});
