/**
 * The admin API's session-cookie plumbing, exercised through the real handler.
 *
 * This file exists because a missing import shipped: `routes-admin.ts` called
 * `getSessionWithCookie` without importing it, and EVERY cookie-authenticated
 * request answered 500 "getSessionWithCookie is not defined". The existing
 * session tests all called `panel-session.ts` directly, so none of them touched
 * the handler that actually wires it up — the unit under test passed while the
 * route was broken.
 *
 * So these tests go through `createAdminHandler` with a real Request, and assert
 * on the real Response. They are deliberately end-to-end for that reason: the
 * failure mode being guarded against is "the pieces work but are not connected".
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminHandler, type AdminRouteOptions } from "./routes-admin.js";
import {
  SESSION_COOKIE,
  resetPanelAuthForTest,
  setClockForTest,
  setIdleTimeoutMs,
} from "./panel-session.js";
import { AuthManager } from "../auth/manager.js";
import { resetAccountStoreCacheForTest } from "../auth/account-store.js";
import type { ProxyConfig } from "../config/types.js";

const TMP_ROOT = join(tmpdir(), `zk-admin-session-${process.pid}`);
let fakeNow = 1_700_000_000_000;
let seq = 0;

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
  setClockForTest(() => fakeNow);
  setIdleTimeoutMs(5 * 60_000);
  resetPanelAuthForTest();
  process.env.ZCODE_KNIGHT_STORE_DIR = join(TMP_ROOT, `run-${seq++}`);
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(TMP_ROOT, "legacy");
  resetAccountStoreCacheForTest();
});

afterEach(() => {
  setClockForTest(null);
  resetPanelAuthForTest();
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  resetAccountStoreCacheForTest();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function makeConfig(): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { panelPassword: "sk-test" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
  } as ProxyConfig;
}

function handler() {
  const opts: AdminRouteOptions = {
    config: makeConfig(),
    auth: new AuthManager(),
    adminKey: "sk-test",
  };
  return createAdminHandler(opts);
}

/** Drive a request through the handler. */
async function call(
  path: string,
  init: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://127.0.0.1:17800/admin/api${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const res = await handler()(req);
  if (!res) throw new Error(`handler returned null for ${path}`);
  return res;
}

function maxAge(res: Response): number {
  const m = /Max-Age=(\d+)/.exec(res.headers.get("set-cookie") ?? "");
  return m ? Number(m[1]) : -1;
}
function tokenOf(res: Response): string {
  const m = /zk_panel=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return m ? m[1] : "";
}

/** Log in and return the cookie header to send on later requests. */
async function login(): Promise<string> {
  const res = await call("/login", { method: "POST", body: { key: "sk-test" } });
  expect(res.status).toBe(200);
  const token = tokenOf(res);
  expect(token).not.toBe("");
  return `${SESSION_COOKIE}=${token}`;
}

describe("cookie-authenticated requests actually work", () => {
  it("a session cookie authenticates a GET (no 500)", async () => {
    // The regression: an unimported symbol made this a 500 with the message
    // "getSessionWithCookie is not defined". Asserting only "not 401" would
    // have missed it — the check is that the route RUNS.
    const cookie = await login();
    const res = await call("/overview", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts?: unknown };
    expect(body.accounts).toBeDefined();
  });

  it("the session probe reports ok for a live cookie", async () => {
    const cookie = await login();
    const res = await call("/session", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; idleTimeoutMs: number };
    expect(body.ok).toBe(true);
    expect(body.idleTimeoutMs).toBe(5 * 60_000);
  });

  it("a header key still authenticates (the script/curl path)", async () => {
    const res = await call("/overview", { headers: { "x-admin-key": "sk-test" } });
    expect(res.status).toBe(200);
  });
});

describe("the cookie is re-issued so it cannot outlive the session", () => {
  it("every authenticated response carries a refreshed cookie", async () => {
    const cookie = await login();
    const res = await call("/overview", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
    expect(maxAge(res)).toBe(300);
  });

  it("the refreshed cookie shrinks as idle time passes", async () => {
    // The reported bug: the cookie kept its login-time expiry, so the browser
    // dropped it at the 5-minute mark even during continuous use. After 4 idle
    // minutes the re-issued cookie must carry ~1 minute.
    const cookie = await login();
    fakeNow += 4 * 60_000;
    const res = await call("/overview", { cookie });
    expect(res.status).toBe(200);
    expect(maxAge(res)).toBe(60);
  });

  it("a background poll does not extend the window", async () => {
    // The panel polls /overview every 5s. If that counted as activity the idle
    // timeout could never fire while a tab was open.
    const cookie = await login();
    for (let i = 0; i < 12; i++) {
      fakeNow += 5_000;
      await call("/overview", { cookie });
    }
    const res = await call("/overview", { cookie });
    expect(maxAge(res)).toBeLessThan(300);
  });

  it("a request flagged as active restores the full window", async () => {
    const cookie = await login();
    fakeNow += 4 * 60_000;
    const res = await call("/overview", { cookie, headers: { "x-zk-active": "1" } });
    expect(maxAge(res)).toBe(300);
  });

  it("an expired session is rejected and gets no cookie", async () => {
    const cookie = await login();
    fakeNow += 5 * 60_000 + 1;
    const res = await call("/overview", { cookie });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("logout clears the session", async () => {
    const cookie = await login();
    const out = await call("/logout", { method: "POST", cookie, headers: { "x-csrf-token": "" } });
    // The exact status is the route's business; what matters is that the session
    // is gone afterwards.
    expect(out.status).toBeLessThan(500);
    const after = await call("/session", { cookie });
    const body = (await after.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
