/**
 * Panel idle timeout.
 *
 * The reported symptom: the panel logged out BEFORE the configured 5 minutes,
 * and the intended behaviour is "5 minutes with no activity, then re-ask for
 * the key".
 *
 * Two independent bugs produced that, and they compounded:
 *
 *   1. **The cookie was minted once at login with a fixed `Max-Age`.** The
 *      server's window slides on activity, but a cookie's expiry is fixed when
 *      it is written — so the browser discarded the cookie exactly N minutes
 *      after sign-in regardless of how busy the operator was. Any session older
 *      than the window died on the next navigation, which is why it looked like
 *      "logged out before 5 minutes": the clock had started at login, not at the
 *      last action.
 *
 *   2. **Every request counted as activity.** The panel polls `/overview` every
 *      5 seconds, so the window was refreshed forever and the timeout could
 *      never fire while a tab was open. Fixing only (1) would have converted
 *      "logs out too early" into "never logs out".
 *
 * The fix: the cookie is re-issued on every authenticated response with the
 * REMAINING lifetime, and the window only slides when the client reports that a
 * human touched the page (`x-zk-active`). These tests pin both halves.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  SESSION_COOKIE,
  backdateSessionForTest,
  createSession,
  getSession,
  getSessionWithCookie,
  resetPanelAuthForTest,
  sessionCount,
  setClockForTest,
  setIdleTimeoutMs,
} from "./panel-session.js";

/** Controllable clock, so expiry can be asserted exactly instead of slept for. */
let fakeNow = 1_700_000_000_000;

beforeEach(() => {
  fakeNow = 1_700_000_000_000;
  setClockForTest(() => fakeNow);
  setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);
  resetPanelAuthForTest();
});

afterEach(() => {
  setClockForTest(null);
  setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);
  resetPanelAuthForTest();
});

/** Max-Age from a Set-Cookie string, in seconds. */
function maxAgeOf(cookie: string): number {
  const m = /Max-Age=(\d+)/.exec(cookie);
  if (!m) throw new Error(`no Max-Age in ${cookie}`);
  return Number(m[1]);
}

describe("the cookie tracks the remaining window, not the login time", () => {
  it("a fresh login gets the full window", () => {
    const { cookie } = createSession();
    expect(maxAgeOf(cookie)).toBe(DEFAULT_IDLE_TIMEOUT_MS / 1000);
  });

  it("the re-issued cookie shrinks as idle time passes", () => {
    // This is the fix for "logged out before 5 minutes". After 4 minutes of no
    // activity the cookie must carry ~1 minute, not a fresh 5 — otherwise the
    // browser would keep a cookie the server is about to reject.
    const { token } = createSession();
    fakeNow += 4 * 60_000;

    const r = getSessionWithCookie(token, false)!;
    expect(r).not.toBeNull();
    expect(maxAgeOf(r.cookie!)).toBe(60);
  });

  it("activity extends the window back to full", () => {
    const { token } = createSession();
    fakeNow += 4 * 60_000;
    expect(maxAgeOf(getSessionWithCookie(token, true)!.cookie!)).toBe(300);
  });

  it("a background poll does NOT extend the window", () => {
    // The panel's /overview timer. If this extended the window the timeout
    // could never fire while a tab was open.
    const { token } = createSession();
    backdateSessionForTest(token, 4 * 60_000);

    const r = getSessionWithCookie(token, false)!;
    expect(r.session).not.toBeNull();
    expect(maxAgeOf(r.cookie!)).toBe(60);

    // Repeated polls must not creep the expiry back up either.
    for (let i = 0; i < 10; i++) getSessionWithCookie(token, false);
    expect(maxAgeOf(getSessionWithCookie(token, false)!.cookie!)).toBe(60);
  });
});

describe("expiry is exact", () => {
  it("a session is alive AT the limit", () => {
    const { token } = createSession();
    fakeNow += DEFAULT_IDLE_TIMEOUT_MS;
    expect(getSession(token, false)).not.toBeNull();
  });

  it("a session is gone one millisecond past the limit", () => {
    const { token } = createSession();
    fakeNow += DEFAULT_IDLE_TIMEOUT_MS + 1;
    expect(getSession(token, false)).toBeNull();
  });

  it("polling does not keep a session alive past the limit", () => {
    // The whole point: a tab left open with the panel polling must still expire.
    const { token } = createSession();
    for (let elapsed = 0; elapsed <= DEFAULT_IDLE_TIMEOUT_MS + 60_000; elapsed += 5_000) {
      fakeNow += 5_000;
      getSessionWithCookie(token, false); // the /overview poll
    }
    expect(getSession(token, false)).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it("activity every few minutes keeps it alive indefinitely", () => {
    const { token } = createSession();
    for (let i = 0; i < 20; i++) {
      fakeNow += 4 * 60_000;                 // 4 min: inside the window
      expect(getSession(token, true)).not.toBeNull();
    }
  });
});

describe("configuration", () => {
  it("honours a custom timeout", () => {
    setIdleTimeoutMs(60_000);
    const { token, cookie } = createSession();
    expect(maxAgeOf(cookie)).toBe(60);

    fakeNow += 59_000;
    expect(getSession(token, false)).not.toBeNull();
    fakeNow += 2_000;
    expect(getSession(token, false)).toBeNull();
  });

  it("0 means never time out", () => {
    setIdleTimeoutMs(0);
    const { token, cookie } = createSession();
    // A year, the documented stand-in for "no expiry".
    expect(maxAgeOf(cookie)).toBe(31536000);

    fakeNow += 400 * 24 * 60 * 60 * 1000;
    expect(getSession(token, false)).not.toBeNull();
  });

  it("a non-finite or negative value is ignored, not treated as never", () => {
    setIdleTimeoutMs(90_000);
    setIdleTimeoutMs(Number.NaN);
    expect(getSession(createSession().token, false)).not.toBeNull();
    // Still the 90s window, not "never": a config typo must not disable logout.
    const { token } = createSession();
    fakeNow += 91_000;
    expect(getSession(token, false)).toBeNull();
  });

  it("clamps a value below the panel's own poll interval", () => {
    // Under 10s the panel would log itself out between polls.
    setIdleTimeoutMs(1_000);
    const { cookie } = createSession();
    expect(maxAgeOf(cookie)).toBe(10);
  });
});

describe("cookie plumbing", () => {
  it("an unknown or absent token yields nothing", () => {
    expect(getSessionWithCookie(undefined, true)).toBeNull();
    expect(getSessionWithCookie("nope", true)).toBeNull();
  });

  it("the cookie keeps its security attributes after a refresh", () => {
    const { token } = createSession();
    const c = getSessionWithCookie(token, true)!.cookie!;
    expect(c).toContain(`${SESSION_COOKIE}=${token}`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/admin");
  });
});
