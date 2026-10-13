/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 * 吾爱破解 52pojie: https://www.52pojie.cn/home.php?mod=space&uid=2394304
 * 交流群: 1091692024 — https://qm.qq.com/q/sUAFJgC3Fm
 *
 * 版本 Version: v4.7.13
 * 本项目完全开源，不存在收费，收费的一律是骗子！
 * 请以作者发布的最终版本为准。本项目传承开源精神，在遵守适用法律、原作者声明及相关第三方
 * 许可的前提下，欢迎下载、学习、修改和二次开发；二次分发时请保留代码与页面中已有的原作者
 * 版权注释、署名链接和免责声明，不得把非官方修改版冒充为作者最终版本。
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Admin invite-registry routes, exercised through the real handler.
 *
 * Same end-to-end discipline as admin-session-route.test.ts: the failure mode
 * this guards against is "the store works but the route is not wired" — the
 * tests drive `createAdminHandler` with real Requests and assert on the real
 * Responses. Everything goes through a TEMP store dir so the developer's real
 * accounts and invites are never touched.
 *
 * Coverage:
 *   - auth (401 without key) and CSRF (403 for a cookie write without a token);
 *   - create / list / filter / paginate;
 *   - manual assign, round-robin assign-next, release;
 *   - duplicate code, expired and capacity-exhausted invites;
 *   - GET /marketing: no account, no-JWT, and a stubbed official fetch
 *     (read-only shape, cache, redaction).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminHandler, resetMarketingCacheForTest, type AdminRouteOptions } from "./routes-admin.js";
import { SESSION_COOKIE, resetPanelAuthForTest } from "./panel-session.js";
import {
  addAccount, resetAccountStoreCacheForTest,
} from "../auth/account-store.js";
import { resetInviteStoreForTest } from "../invite/store.js";
import type { ProxyConfig } from "../config/types.js";

const REAL_FETCH = globalThis.fetch;
const TMP_ROOT = join(tmpdir(), `zk-invite-routes-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(async () => {
  tmp = join(TMP_ROOT, `run-${seq++}`);
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(tmp, "legacy");
  resetAccountStoreCacheForTest();
  resetInviteStoreForTest();
  resetPanelAuthForTest();
  resetMarketingCacheForTest();
  globalThis.fetch = REAL_FETCH;
});

afterEach(async () => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  resetAccountStoreCacheForTest();
  resetInviteStoreForTest();
  resetPanelAuthForTest();
  resetMarketingCacheForTest();
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
    claim: { enabled: false, auto: false, origin: "https://marketing.invalid", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "error" },
  } as ProxyConfig;
}

function handler() {
  const opts: AdminRouteOptions = {
    config: makeConfig(),
    auth: new (require("../auth/manager.js") as typeof import("../auth/manager.js")).AuthManager(),
    adminKey: "sk-test",
  };
  return createAdminHandler(opts);
}

interface CallInit {
  method?: string;
  key?: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.key) headers["x-admin-key"] = init.key;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-csrf-token"] = init.csrf;
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

/** Log in with the panel key and return { cookie, csrf } for cookie-auth writes. */
async function loginSession(): Promise<{ cookie: string; csrf: string }> {
  const res = await call("/login", { method: "POST", body: { key: "sk-test" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrf: string };
  const token = /zk_panel=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  expect(token).not.toBe("");
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: body.csrf };
}

/** Seed one pool account; `withJwt` decides whether it carries a plan JWT. */
async function seedAccount(name: string, withJwt = false): Promise<string> {
  const rec = await addAccount({
    credential: { apiKey: `sk-${name}`, provider: "zai", ...(withJwt ? { jwt: `jwt-${name}` } : {}) },
    name,
  });
  return rec.id;
}

interface InviteEntryDto {
  id: string;
  code: string;
  status: string;
  usedCount: number;
  maxUses: number | null;
  expiresAt: string | null;
  category: string;
}

/** Create one invite through the API (the same way the panel does). */
async function createInvite(body: Record<string, unknown>, key = "sk-test"): Promise<{ res: Response; invite: InviteEntryDto | null }> {
  const res = await call("/invites", { method: "POST", key, body });
  const json = (await res.json()) as { invite?: InviteEntryDto };
  return { res, invite: json.invite ?? null };
}

describe("invite route auth", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await call("/invites");
    expect(res.status).toBe(401);
  });

  it("accepts the header key on a GET", async () => {
    const res = await call("/invites", { key: "sk-test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; accounts: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  it("a cookie write without the CSRF token is 403", async () => {
    const { cookie } = await loginSession();
    const res = await call("/invites", { method: "POST", cookie, body: { code: "NOCSRF01" } });
    expect(res.status).toBe(403);
  });

  it("a cookie write with the CSRF token succeeds", async () => {
    const { cookie, csrf } = await loginSession();
    const res = await call("/invites", { method: "POST", cookie, csrf, body: { code: "WITHCSRF1" } });
    expect(res.status).toBe(200);
  });
});

describe("create / list / filter / page", () => {
  it("creates a manual entry and echoes it back", async () => {
    const { res, invite } = await createInvite({
      code: "ABCD2345", url: "https://zcode.z.ai/invite/ABCD2345",
      category: "campaign", tags: ["wk", "oct"], maxUses: 3,
    });
    expect(res.status).toBe(200);
    expect(invite!.code).toBe("ABCD2345");
    expect(invite!.source).toBe("manual");
    expect(invite!.status).toBe("active");
    expect(invite!.usedCount).toBe(0);
  });

  it("rejects a create without a code", async () => {
    const { res } = await createInvite({ url: "https://x.invalid" });
    expect(res.status).toBe(400);
  });

  it("a non-manual source is refused (registration only, no upstream call)", async () => {
    const { res } = await createInvite({ code: "SRC99999", source: "official" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate code with 409", async () => {
    await createInvite({ code: "DUP00001" });
    const res = await call("/invites", { method: "POST", key: "sk-test", body: { code: "DUP00001" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("duplicate_code");
  });

  it("rejects a malformed expiresAt with 400", async () => {
    const { res } = await createInvite({ code: "BADDATE1", expiresAt: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("PATCH updates fields and 404s on an unknown id", async () => {
    const { invite } = await createInvite({ code: "PATCH001" });
    const ok = await call(`/invites/${invite!.id}`, { method: "PATCH", key: "sk-test", body: { label: "renamed", maxUses: 2 } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { invite: InviteEntryDto };
    expect(body.invite.label).toBe("renamed");

    const missing = await call("/invites/no-such-id", { method: "PATCH", key: "sk-test", body: { label: "x" } });
    expect(missing.status).toBe(404);
  });

  it("lists with search, status and category filters", async () => {
    await createInvite({ code: "FINDAAAA", category: "campaign", tags: ["alpha"] });
    await createInvite({ code: "FIND99BB", category: "personal", note: "needle-in-note" });
    await createInvite({ code: "OTHERCCC", category: "campaign", status: "paused" });

    const all = (await (await call("/invites", { key: "sk-test" })).json()) as { entries: InviteEntryDto[]; total: number };
    expect(all.total).toBe(3);

    const bySearch = (await (await call("/invites?search=needle", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(bySearch.entries.length).toBe(1);
    expect(bySearch.entries[0]!.code).toBe("FIND99BB");

    const byCategory = (await (await call("/invites?category=personal", { key: "sk-test" })).json()) as { entries: InviteEntryDto[]; categories: string[] };
    expect(byCategory.entries.length).toBe(1);
    expect(byCategory.categories.sort()).toEqual(["campaign", "personal"]);

    const byStatus = (await (await call("/invites?status=paused", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(byStatus.entries.length).toBe(1);
    expect(byStatus.entries[0]!.code).toBe("OTHERCCC");
  });

  it("paginates and reports page math", async () => {
    for (let i = 0; i < 5; i++) {
      await createInvite({ code: `PAGE00${i}` });
    }
    const p1 = (await (await call("/invites?page=1&pageSize=2", { key: "sk-test" })).json()) as {
      entries: InviteEntryDto[]; page: number; pageSize: number; total: number; totalPages: number;
    };
    expect(p1.entries.length).toBe(2);
    expect(p1.page).toBe(1);
    expect(p1.total).toBe(5);
    expect(p1.totalPages).toBe(3);
    const p3 = (await (await call("/invites?page=3&pageSize=2", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(p3.entries.length).toBe(1);
  });

  it("stats returns counters and settings", async () => {
    await createInvite({ code: "STAT001", status: "paused" });
    await createInvite({ code: "STAT002" });
    const res = await call("/invites/stats", { key: "sk-test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { total: number; paused: number; active: number };
      settings: { defaultStrategy: string };
    };
    expect(body.stats.total).toBe(2);
    expect(body.stats.paused).toBe(1);
    expect(body.settings.defaultStrategy).toBe("round_robin");
  });
});

describe("assign / assign-next / release", () => {
  it("manual assign gives a specific entry to an account", async () => {
    const accountId = await seedAccount("assignee");
    const { invite } = await createInvite({ code: "MANUAL01" });
    const res = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId, requestId: "req-1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      assignment: { accountId: string; strategy: string; result: string };
      invite: InviteEntryDto;
    };
    expect(body.ok).toBe(true);
    expect(body.assignment.accountId).toBe(accountId);
    expect(body.assignment.strategy).toBe("manual");
    expect(body.assignment.result).toBe("req-1");
    expect(body.invite.usedCount).toBe(1);
  });

  it("manual assign to an unknown account is 404", async () => {
    const { invite } = await createInvite({ code: "NOACCT01" });
    const res = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId: "ghost" } });
    expect(res.status).toBe(404);
  });

  it("release returns the code (usedCount decremented) and re-assign works", async () => {
    const accountId = await seedAccount("releasor");
    const { invite } = await createInvite({ code: "RELEAS01", maxUses: 1 });
    const assigned = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(assigned.status).toBe(200);

    // A capacity-1 code, now used up: a second assign must be refused…
    const second = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(second.status).toBe(409);

    const rel = await call(`/invites/${invite!.id}/release`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(rel.status).toBe(200);
    const relBody = (await rel.json()) as { assignment: { consumedAt: string | null }; ok: boolean };
    expect(relBody.ok).toBe(true);
    expect(relBody.assignment.consumedAt).not.toBeNull();

    // …and after release the code is available again.
    const again = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { invite: InviteEntryDto };
    expect(againBody.invite.usedCount).toBe(1);

    // Releasing the NEW live assignment closes it, so a third release finds
    // nothing and answers 404.
    const rel2 = await call(`/invites/${invite!.id}/release`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(rel2.status).toBe(200);
    const empty = await call(`/invites/${invite!.id}/release`, { method: "POST", key: "sk-test", body: {} });
    expect(empty.status).toBe(404);
  });

  it("assign-next round-robins across the least-assigned active entry", async () => {
    const accountId = await seedAccount("rruser");
    const a = await createInvite({ code: "RRAA0001" });
    const b = await createInvite({ code: "RRBB0002" });
    const first = await call("/invites/assign-next", { method: "POST", key: "sk-test", body: { accountId, strategy: "round_robin", requestId: "rr-1" } });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { assignment: { strategy: string }; invite: InviteEntryDto };
    expect(firstBody.assignment.strategy).toBe("round_robin");
    // Same account again: round-robin must NOT hand the same code twice.
    const second = await call("/invites/assign-next", { method: "POST", key: "sk-test", body: { accountId, strategy: "round_robin" } });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { invite: InviteEntryDto };
    expect(secondBody.invite.id).not.toBe(firstBody.invite.id);
    // Both seeded entries are now used exactly once each.
    const list = (await (await call("/invites", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    const byId = new Map(list.entries.map((e) => [e.id, e]));
    expect(byId.get(a.invite!.id)!.usedCount).toBe(1);
    expect(byId.get(b.invite!.id)!.usedCount).toBe(1);
  });

  it("assign-next with a category picks within the category", async () => {
    const accountId = await seedAccount("catuser");
    await createInvite({ code: "CATA0001", category: "vip" });
    await createInvite({ code: "CATB0002", category: "normal" });
    const res = await call("/invites/assign-next", { method: "POST", key: "sk-test", body: { accountId, strategy: "round_robin", category: "vip" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite: InviteEntryDto };
    expect(body.invite.category).toBe("vip");
  });

  it("assign-next with nothing available is 409", async () => {
    const accountId = await seedAccount("emptyuser");
    const res = await call("/invites/assign-next", { method: "POST", key: "sk-test", body: { accountId, strategy: "round_robin" } });
    expect(res.status).toBe(409);
  });

  it("settings update persists and validates the strategy", async () => {
    const ok = await call("/invites/settings", { method: "POST", key: "sk-test", body: { defaultStrategy: "manual" } });
    expect(ok.status).toBe(200);
    const stats = (await (await call("/invites/stats", { key: "sk-test" })).json()) as { settings: { defaultStrategy: string } };
    expect(stats.settings.defaultStrategy).toBe("manual");

    const bad = await call("/invites/settings", { method: "POST", key: "sk-test", body: { defaultStrategy: "chaos" } });
    expect(bad.status).toBe(400);
  });
});

describe("DELETE /invites/:id — remove a registry entry", () => {
  it("removes an unreferenced entry", async () => {
    const { invite } = await createInvite({ code: "DELME001" });
    const res = await call(`/invites/${invite!.id}`, { method: "DELETE", key: "sk-test" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const list = (await (await call("/invites", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(list.entries.some((e) => e.code === "DELME001")).toBe(false);
  });

  it("refuses while a live reservation points at it (release first)", async () => {
    // Deleting the entry out from under a live reservation would leave that
    // account's card referencing an invite that no longer exists.
    const accountId = await seedAccount("delholder");
    const { invite } = await createInvite({ code: "DELINUSE" });
    await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });

    const blocked = await call(`/invites/${invite!.id}`, { method: "DELETE", key: "sk-test" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { type: string } }).error.type).toBe("in_use");

    // After releasing, the same delete succeeds.
    await call(`/invites/${invite!.id}/release`, { method: "POST", key: "sk-test", body: { accountId } });
    const ok = await call(`/invites/${invite!.id}`, { method: "DELETE", key: "sk-test" });
    expect(ok.status).toBe(200);
  });

  it("404s on an unknown id", async () => {
    const res = await call("/invites/does-not-exist", { method: "DELETE", key: "sk-test" });
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const { invite } = await createInvite({ code: "DELAUTH1" });
    const res = await call(`/invites/${invite!.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe("expired / capacity states", () => {
  it("an expired invite is filtered as expired and refused on assign", async () => {
    const accountId = await seedAccount("expuser");
    const past = new Date(Date.now() - 60_000).toISOString();
    const { invite } = await createInvite({ code: "EXPIRE01", expiresAt: past });
    const byStatus = (await (await call("/invites?status=expired", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(byStatus.entries.map((e) => e.code)).toContain("EXPIRE01");
    const res = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(res.status).toBe(409);
  });

  it("a maxUses-0 invite is exhausted immediately and assign is 409", async () => {
    const accountId = await seedAccount("capuser");
    const { invite } = await createInvite({ code: "EXHAUST1", maxUses: 0 });
    const byStatus = (await (await call("/invites?status=exhausted", { key: "sk-test" })).json()) as { entries: InviteEntryDto[] };
    expect(byStatus.entries.map((e) => e.code)).toContain("EXHAUST1");
    const res = await call(`/invites/${invite!.id}/assign`, { method: "POST", key: "sk-test", body: { accountId } });
    expect(res.status).toBe(409);
  });

  it("usedCount beyond maxUses is refused on create", async () => {
    const { res } = await createInvite({ code: "OVERCAP1", maxUses: 1, usedCount: 5 });
    expect(res.status).toBe(400);
  });
});

describe("GET /marketing (read-only official touch)", () => {
  it("without accountId is 400", async () => {
    const res = await call("/marketing", { key: "sk-test" });
    expect(res.status).toBe(400);
  });

  it("with an unknown account is 404", async () => {
    const res = await call("/marketing?accountId=ghost", { key: "sk-test" });
    expect(res.status).toBe(404);
  });

  it("with a no-JWT account is 400 no_jwt and makes NO fetch", async () => {
    const id = await seedAccount("nojwt");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const res = await call(`/marketing?accountId=${id}`, { key: "sk-test" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("no_jwt");
    expect(fetched).toBe(false);
  });

  it("with a JWT account performs exactly three READ calls to the official endpoints and caches", async () => {
    const id = await seedAccount("mkt", true);
    const urls: string[] = [];
    const auths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      urls.push(url);
      const auth = input instanceof Request
        ? String(input.headers.get("authorization") ?? "")
        : String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "");
      auths.push(auth);
      // Minimal referral/summary envelope (gameplay online, an invite code).
      if (url.includes("referral/summary")) {
        return Response.json({ code: 0, data: { gameplay: { status: "online" }, inviter: { visible: true, state: "active", invite_code: "ABCD2345" } } });
      }
      return Response.json({ code: 0, data: { invitees: [], records: [], next_cursor: null } });
    }) as typeof fetch;

    const res = await call(`/marketing?accountId=${id}`, { key: "sk-test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accountId: string; readonly: boolean; fresh: boolean;
      summary: { inviter?: { invite_code?: string } } | null;
      invitees: unknown; rewardRecords: unknown;
    };
    expect(body.accountId).toBe(id);
    expect(body.readonly).toBe(true);
    expect(body.fresh).toBe(true);
    expect(body.summary?.inviter?.invite_code).toBe("ABCD2345");
    expect(urls.length).toBe(3);
    expect(urls.every((u) => u.startsWith("https://marketing.invalid/api/v1/incentive/"))).toBe(true);
    expect(urls.some((u) => u.includes("referral/summary"))).toBe(true);
    // The credential rides the Authorization header exactly as the balance
    // poller reuses it; the account's own deviceMid was sent along.
    expect(auths.every((a) => a === "Bearer jwt-mkt")).toBe(true);
    // No write endpoint may ever be called by this route.
    expect(urls.every((u) => !u.includes("bind-code"))).toBe(true);

    // Second call is served from the 5-minute cache: still 3 total fetches.
    const res2 = await call(`/marketing?accountId=${id}`, { key: "sk-test" });
    expect(res2.status).toBe(200);
    expect(urls.length).toBe(3);
  });

  it("a failed official fetch surfaces a redacted error, not the credential", async () => {
    const id = await seedAccount("fail", true);
    globalThis.fetch = (async () => {
      throw new Error(`fetch failed https://marketing.invalid/api/v1/incentive/x?token=jwt-fail`);
    }) as typeof fetch;
    const res = await call(`/marketing?accountId=${id}`, { key: "sk-test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fresh: boolean; summaryError?: string; summary: unknown;
    };
    expect(body.fresh).toBe(false);
    expect(body.summary).toBeNull();
    expect(body.summaryError).toBe("network_error");
    // Redaction: the raw error text (which carried the JWT in this stub) must
    // not appear anywhere in the response.
    const raw = JSON.stringify(body);
    expect(raw.includes("jwt-fail")).toBe(false);
  });
});
