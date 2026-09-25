/**
 * Behavioural test for the empty-balance explanation.
 *
 * Every empty balance row used to render one fixed sentence — "no balance data
 * (re-login this account)" — no matter why it was empty. Four different
 * situations produce an empty row and they call for four different operator
 * actions:
 *
 *   - `no_plan`      the gateway answered and the account simply holds no plan;
 *                    re-logging-in changes nothing, subscribing does
 *   - `auth`         the credential was rejected; re-login IS the fix
 *   - `unavailable`  the read failed (network/5xx); retrying is the fix
 *   - `no_jwt`       a coding-plan key account, which has no billing endpoint
 *                    to ask at all — permanent, not a failure
 *
 * The bug was not that the sentence was wrong for one case; it was that it
 * advised a re-login for all of them, so the operator re-logged-in accounts that
 * were never the problem and never fixed the ones that were.
 *
 * panel-integrity.test.ts proves the i18n keys exist. This proves the MAPPING —
 * which state produces which message — by running the panel's real function.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { adminPanelHtml } from "./panel-html.js";

let win: GlobalWindow;

beforeEach(() => {
  win = new GlobalWindow({ url: "http://127.0.0.1:17800/admin" });
});

afterEach(() => {
  win.close();
});

/**
 * Lift the panel's own balanceEmptyText out and run it against the real
 * dictionaries.
 *
 * Extracted rather than reimplemented: a test that restated the mapping would
 * keep passing after the panel's copy changed. The function is pure, so it can
 * be evaluated on its own without booting the panel.
 */
function loadBalanceEmptyText(): (rec: unknown) => string {
  const html = adminPanelHtml();
  const fn = /function balanceEmptyText\(rec\) \{[\s\S]*?\n\}/.exec(html);
  if (!fn) throw new Error("balanceEmptyText not found in the panel");
  // The two dictionaries, taken verbatim so the assertions check the text the
  // user actually reads.
  const zh = /zh: \{([\s\S]*?)\n  \},/.exec(html);
  const en = /en: \{([\s\S]*?)\n  \},/.exec(html);
  if (!zh || !en) throw new Error("i18n dictionaries not found in the panel");
  // eslint-disable-next-line no-new-func
  const make = new Function(
    "I18N",
    "T",
    "esc",
    `${fn[0]}\nreturn balanceEmptyText;`,
  ) as (i18n: unknown, t: (k: string) => string, esc: (s: string) => string) => (rec: unknown) => string;
  // Evaluate the two object literals exactly as written.
  // eslint-disable-next-line no-new-func
  const dict = new Function(`return { zh: {${zh[1]}\n}, en: {${en[1]}\n} };`)() as Record<string, Record<string, string>>;
  const T = (k: string): string => dict.zh![k] ?? k;
  return make(dict, T, (s: string) => String(s));
}

describe("empty balance rows name their real cause", () => {
  it("maps each balanceState to its own message", () => {
    const text = loadBalanceEmptyText();

    const noPlan = text({ balanceState: "no_plan" });
    const auth = text({ balanceState: "auth" });
    const unavailable = text({ balanceState: "unavailable" });
    const noJwt = text({ balanceState: "no_jwt" });

    // All four are distinct — the whole point of the fix.
    const all = [noPlan, auth, unavailable, noJwt];
    expect(new Set(all).size).toBe(4);

    // The re-login advice is reserved for the case where it actually helps.
    expect(auth).toContain("重新登录");
    expect(noPlan).not.toContain("重新登录");
    expect(noJwt).not.toContain("重新登录");

    // And each names its own situation, so the operator knows what to do.
    expect(noPlan).toContain("套餐");
    expect(unavailable).toContain("读取失败");
    expect(noJwt).toContain("JWT");
  });

  it("prefers the upstream error text when there is one", () => {
    // A specific upstream error ("connect timeout") is more useful than any
    // fixed label, so it wins regardless of state.
    const text = loadBalanceEmptyText();
    const out = text({ balanceState: "unavailable", errors: ["connect timeout to zcode.z.ai"] });
    expect(out).toBe("connect timeout to zcode.z.ai");
  });

  it("falls back to the re-login line when the state is unknown", () => {
    // An older engine that does not send balanceState, or an unexpected value:
    // keep the original message rather than inventing a cause we cannot see.
    const text = loadBalanceEmptyText();
    const legacy = text({});
    expect(legacy).toContain("重新登录");
    expect(text({ balanceState: "something_new" })).toBe(legacy);
  });
});
