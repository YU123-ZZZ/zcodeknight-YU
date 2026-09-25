/**
 * Behavioural tests for two panel defects.
 *
 * ## 1. The gate leaked
 *
 * `<body>` carried no `gated` class, and boot() added it from JavaScript. The
 * panel markup is in the DOM the whole time, so between the browser painting the
 * body and the script reaching boot() the panel was VISIBLE with no session — a
 * refresh landing in that window showed it. Reported as "keep refreshing the
 * login page and sometimes the panel breaks through". The fix makes the markup
 * the safe state: the class is already there, and boot() removes it only after
 * the session is confirmed.
 *
 * ## 2. Refreshing accounts hitched the overview
 *
 * `loadBalances()` blanked the overview list to "Loading…" on every call, and
 * refreshAccounts() calls it on every pool change. So refreshing on the ACCOUNTS
 * page wiped the OVERVIEW's finished list and repainted it.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "admin.txt"), "utf-8");

describe("a failed account action is reported, not swallowed", () => {
  /**
   * `okOrToast` run against real Response objects with a stubbed toast.
   *
   * Every account button used to fire its request and refresh, ignoring the
   * answer — so a rejected operation was indistinguishable from a dead button,
   * and the operator clicked again. Delete was the worst: the confirm dialog
   * made it look like something had happened.
   */
  function fn(): (toast: (m: string) => void) => (resp: Response) => Promise<boolean> {
    const src = /async function okOrToast\([\s\S]*?\n\}/.exec(html);
    if (!src) throw new Error("okOrToast not found in the panel");
    // The panel's okOrToast closes over `toast`; inject it, then hand back the
    // function so the caller can drive it with real Response objects.
    // eslint-disable-next-line no-new-func
    return new Function("toast", `${src[0]}\nreturn okOrToast;`) as (
      t: (m: string) => void,
    ) => (resp: Response) => Promise<boolean>;
  }

  it("passes a successful response through with no toast", async () => {
    const toasts: string[] = [];
    const ok = await fn()((m) => toasts.push(m))(new Response("{}", { status: 200 }));
    expect(ok).toBe(true);
    expect(toasts).toEqual([]);
  });

  it("surfaces the server's own message when one is given", async () => {
    // The pause route answers 500 with a reason when the store cannot be
    // written; that reason is the whole point of surfacing it.
    const toasts: string[] = [];
    const body = JSON.stringify({ error: { type: "persist_failed", message: "paused in memory but could not be saved: disk full" } });
    const ok = await fn()((m) => toasts.push(m))(
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
    );
    expect(ok).toBe(false);
    expect(toasts).toEqual(["paused in memory but could not be saved: disk full"]);
  });

  it("falls back to the status when the body is not our JSON", async () => {
    const toasts: string[] = [];
    const ok = await fn()((m) => toasts.push(m))(new Response("<html>502</html>", { status: 502 }));
    expect(ok).toBe(false);
    expect(toasts).toEqual(["HTTP 502"]);
  });
});

describe("the plan toggle is shown but inert where it cannot stick", () => {
  it("is rendered for every account, disabled when a JWT pins the tier", () => {
    // The tier is derived from the credential on every load (repairPlanTier) and
    // upstream refuses a JWT credential on the coding-plan endpoints, so on a JWT
    // account the click used to flip the label and then flip back on the next
    // reload, with nothing to explain why.
    //
    // It was then HIDDEN for those accounts, which the operator read as "an
    // option went missing" — a fair reading, since the button is how they had
    // been switching tiers. Disabled-with-a-reason keeps the control visible and
    // still tells the truth.
    const plan = /mkBtn\(a\.plan === "start-plan" \? T\("act_paid"\)[\s\S]*?a\.hasJwt \? T\("plan_locked_jwt"\) : ""\)/.exec(html);
    expect(plan).not.toBeNull();
    // And it must not be wrapped in a conditional that removes it.
    expect(html).not.toMatch(/if \(!a\.hasJwt\) \{\s*\n\s*mkBtn\(a\.plan/);
  });

  it("mkBtn supports the disabled state and explains itself on hover", () => {
    const mkBtn = /const mkBtn = \([\s\S]*?actions\.appendChild\(b\);\s*\n    \};/.exec(html);
    expect(mkBtn).not.toBeNull();
    expect(mkBtn![0]).toContain("b.disabled = true");
    expect(mkBtn![0]).toContain("b.title = blockedReason");
  });

  it("the disabled style exists, so an inert button does not look clickable", () => {
    // Without this the button keeps its normal appearance and the operator just
    // clicks a thing that does nothing.
    expect(html).toContain(".btn:disabled {");
  });
});

describe("account actions surface their failures", () => {
  /** The body of a button handler registered with mkBtn, by its i18n label. */
  function handlerBody(label: string): string {
    const re = new RegExp(`mkBtn\\(T\\("${label}"\\)[\\s\\S]*?\\n    \\}\\);`);
    const found = re.exec(html);
    if (!found) throw new Error(`handler for ${label} not found in the panel`);
    return found[0];
  }

  it("delete reports a failure instead of failing silently", () => {
    // The worst case in the panel: the operator confirms a destructive action,
    // nothing is deleted, and the card still sitting there is the only clue.
    expect(handlerBody("act_delete")).toContain("okOrToast");
  });

  it("set-default reports a failure too", () => {
    expect(handlerBody("act_default")).toContain("okOrToast");
  });

  it("act() refreshes only when the call succeeded", () => {
    const act = /async function act\(path, id, paused, extra\) \{[\s\S]*?\n\}/.exec(html);
    expect(act).not.toBeNull();
    const src = act![0];
    // The early return must come before the refresh, or the unchanged card is
    // repainted and a rejection looks like a no-op.
    expect(src).toMatch(/if \(!\(await okOrToast\(r\)\)\) return;/);
    expect(src.indexOf("okOrToast")).toBeLessThan(src.indexOf("refreshAccounts()"));
  });
});

describe("the panel starts gated", () => {
  it("hides the panel from the first paint, before any script runs", () => {
    // The class must be in the MARKUP. Adding it from JS is what left the window
    // open: the markup is served and rendered before the script executes.
    expect(html).toMatch(/<body class="gated">/);
  });

  it("the gate covers the panel and nothing else", () => {
    // .side + main are the panel chrome. Everything else — the login dialog, the
    // masks, the toasts — is a sibling and must stay usable while gated, or a
    // fresh visitor would get a blank page with no way to log in.
    expect(html).toContain("body.gated .side,");
    expect(html).toContain("body.gated main { visibility: hidden; }");
    // #login-mask must NOT be inside main, or gating would hide the only way in.
    const mainStart = html.indexOf("<main>");
    const mainEnd = html.indexOf("</main>");
    const login = html.indexOf('id="login-mask"');
    expect(mainStart).toBeGreaterThan(0);
    expect(mainEnd).toBeGreaterThan(mainStart);
    expect(login).toBeGreaterThan(mainEnd);
  });

  it("only un-hides the panel after the session check", () => {
    // Both statements live in boot(); the remove must come after the
    // resumeSession/login sequence, never before it.
    const boot = /async function boot\(\) \{[\s\S]*?\n\}/.exec(html);
    expect(boot).not.toBeNull();
    const src = boot![0];
    const add = src.indexOf('classList.add("gated")');
    const check = src.indexOf("resumeSession");
    const remove = src.indexOf('classList.remove("gated")');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(add);
    expect(remove).toBeGreaterThan(check);
  });
});

describe("refreshing the accounts page does not blank the overview", () => {
  /**
   * `loadBalances` with `api` and the DOM stubbed, so the real function runs.
   * Returns the innerHTML assignments made to #ov-balances.
   */
  function harness(responses: Record<string, unknown>) {
    const writes: string[] = [];
    const el = {
      dataset: {} as Record<string, string>,
      get innerHTML() { return writes[writes.length - 1] ?? ""; },
      set innerHTML(v: string) { writes.push(v); },
    };
    const doc = {
      getElementById: (id: string) => (id === "ov-balances" ? el : { textContent: "" }),
    };
    const fetched: string[] = [];
    const api = async (path: string) => {
      fetched.push(path);
      const body = responses[path];
      if (body === undefined) throw new Error(`unexpected request ${path}`);
      return { json: async () => body };
    };
    const src = /async function loadBalances\([\s\S]*?\n\}/.exec(html);
    if (!src) throw new Error("loadBalances not found in the panel");
    const fn = (
      // eslint-disable-next-line no-new-func
      new Function(
        "document", "api", "T", "lastQuotaRef", "lastAccountMetaRef", "renderTotals", "renderBalanceList",
        `${src[0]}\nreturn loadBalances;`,
      ) as (...a: unknown[]) => (known?: unknown[], knownQuota?: unknown) => Promise<void>
    )(doc, api, (k: string) => k, { v: [] }, { v: new Map() }, () => {}, () => {});
    return { fn: fn, writes, fetched, el };
  }

  it("shows the placeholder only before anything is rendered", async () => {
    const h = harness({ "/accounts/quota": { accounts: [] }, "/accounts": { accounts: [] } });
    await h.fn();
    // First paint: the placeholder is expected.
    expect(h.writes[0]).toContain("loading");

    // Every later sync must keep the finished list on screen until the new data
    // replaces it — this second write is the one that used to blank it.
    const before = h.writes.length;
    await h.fn();
    const after = h.writes.slice(before);
    expect(after.some((w) => w.includes("loading"))).toBe(false);
  });

  it("accepts a known pool instead of re-reading /accounts", async () => {
    const h = harness({ "/accounts/quota": { accounts: [] } });
    await h.fn([{ id: "a1", name: "acct" }]);
    expect(h.fetched).toEqual(["/accounts/quota"]);
  });

  it("accepts a known quota payload instead of re-reading /accounts/quota", async () => {
    // Both the card bars and this list need the quota endpoint, and refreshAccounts
    // now fetches it once and hands the payload to both. Without this the single
    // refresh sent two identical requests — and for an account with no cached
    // snapshot that endpoint performs a LIVE billing read, so the duplicate
    // doubled an upstream burst rather than a local round trip.
    const h = harness({ "/accounts": { accounts: [] } });
    await h.fn([{ id: "a1", name: "acct" }], { accounts: [] });
    expect(h.fetched).toEqual([]);
  });

  it("still reads /accounts when the caller has no pool to hand", async () => {
    const h = harness({ "/accounts/quota": { accounts: [] }, "/accounts": { accounts: [] } });
    await h.fn();
    expect(h.fetched).toEqual(["/accounts/quota", "/accounts"]);
  });
});
