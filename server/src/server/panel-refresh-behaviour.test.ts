/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 *
 * Panel refresh behaviour on the Overview and Accounts pages.
 *
 * Field report 2026-10-13, reproduced live: while requests were running,
 * opening Overview or Accounts showed the pool with accounts MISSING, and the
 * numbers did not match the running traffic. Three separate causes, each pinned
 * here by reading the shipped panel source:
 *
 *   1. `showPage("accounts")` fired `refreshAccounts()` without first painting
 *      the list it already had, so a page switch showed an empty pool for one
 *      round trip.
 *   2. `refreshAccounts()` assigned `lastAccounts = j.accounts || []` — a
 *      failed or partial store read rendered as "no accounts" and wiped the
 *      cards until the next successful poll.
 *   3. `loadBalances()` blanked the overview list on failure, so one bad round
 *      trip made every account disappear from Overview.
 *
 * The assertions are source-level on purpose: these are wiring bugs (which call
 * happens before which render), and a DOM harness that reimplements the wiring
 * would pass while the shipped panel still flickered.
 */
import { describe, it, expect } from "bun:test";
import { adminPanelSource } from "./panel-html.js";

const html = adminPanelSource();

/** Body of a top-level function in the panel source, by name. */
function fnBody(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m");
  const m = re.exec(html);
  if (!m) throw new Error(`function ${name} not found in the panel source`);
  return m[0];
}

describe("switching pages never blanks a rendered list", () => {
  it("accounts: repaints the cached pool before refreshing", () => {
    const body = fnBody("showPage");
    // The cached render must come FIRST; the refresh is allowed after it.
    const renderAt = body.indexOf("renderAccounts(lastAccounts)");
    const refreshAt = body.indexOf("refreshAccounts()");
    expect(renderAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(renderAt).toBeLessThan(refreshAt);
    // ...and only when there is something to paint.
    expect(body).toMatch(/if \(lastAccounts\.length\) renderAccounts\(lastAccounts\)/);
  });

  it("overview: re-renders from the data in hand instead of showing a placeholder", () => {
    const body = fnBody("showPage");
    expect(body).toContain("renderBalanceList()");
    expect(body).toMatch(/dataset\.loaded === "1"\) renderBalanceList\(\)/);
  });
});

describe("a failed poll keeps the last good list on screen", () => {
  it("refreshAccounts refuses to wipe a non-empty pool with an empty answer", () => {
    const body = fnBody("refreshAccounts");
    // The guard must exist and must come BEFORE lastAccounts is reassigned.
    const guardAt = body.indexOf("next.length === 0 && lastAccounts.length > 0");
    const assignAt = body.indexOf("lastAccounts = next");
    expect(guardAt).toBeGreaterThan(-1);
    expect(assignAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(assignAt);
  });

  it("loadBalances keeps a rendered list when the fetch fails", () => {
    const body = fnBody("loadBalances");
    // On failure with a rendered list: log, do NOT replace the list with "—".
    expect(body).toMatch(/if \(el\.dataset\.loaded === "1"\) \{[\s\S]*?\} else \{[\s\S]*?ov-total-quota/);
  });
});

describe("the overview refreshes its list on the same tick as its tiles", () => {
  it("the 5s poll drives loadBalances in silent mode while Overview is visible", () => {
    // The list used to refresh only on pool actions, so in-flight counts on the
    // balance cards lagged the header tiles by minutes ("数据显示不实时").
    expect(html).toMatch(/loadBalances\(lastAccounts, null, \{ silent: true \}\)/);
  });

  it("silent mode uses a shorter recent-data window than a user-initiated load", () => {
    const body = fnBody("loadBalances");
    expect(body).toContain("const silent = !!(opts && opts.silent)");
    expect(body).toMatch(/const recentMs = silent \? 4_000 : 8_000/);
  });
});
