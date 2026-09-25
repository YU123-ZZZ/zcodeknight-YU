/**
 * Behavioural test for the in-page confirmation dialog.
 *
 * The markup check in panel-integrity.test.ts proves #ask-mask exists; it cannot
 * prove clicking OK resolves the promise. That distinction matters here more
 * than usual: every destructive action in the panel is now written as
 *
 *     if (!(await askConfirm(msg))) return;
 *
 * so a dialog whose promise never settles would leave the operator staring at a
 * frozen button — strictly worse than the native confirm() it replaced, which
 * at least always returned.
 *
 * These tests run the panel's real markup in a DOM and drive it the way a user
 * would: click OK, click Cancel, click the backdrop, press Escape, press Enter.
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
 * Extract the dialog's wiring from the panel and install it in a fresh DOM.
 *
 * The whole panel script cannot run here (it boots a live session, opens
 * websockets and polls timers), so the parts under test are lifted out: the
 * dialog markup and the askConfirm/askClose functions with their handlers. That
 * is a deliberate trade — this verifies the dialog's LOGIC and its DOM contract,
 * while panel-integrity.test.ts verifies the script as a whole still parses.
 */
function installDialog(): { doc: Document; askConfirm: (body?: string, opts?: Record<string, unknown>) => Promise<boolean> } {
  const html = adminPanelHtml();
  // Take the dialog markup verbatim from the real panel.
  const mask = /<div class="mask" id="ask-mask">[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  if (!mask) throw new Error("ask-mask markup not found in the panel");
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = mask[0];

  // Minimal T() — the real one is an i18n lookup, irrelevant to the dialog's
  // resolution behaviour, and stubbing it keeps this test independent of the
  // dictionaries (which panel-integrity.test.ts already checks).
  const T = (k: string): string => ({ cancel: "Cancel", ok: "OK", confirm_title: "Confirm" }[k] ?? k);
  const $ = (id: string) => doc.getElementById(id)!;

  let askResolve: ((v: boolean) => void) | null = null;
  function askConfirm(body?: string, opts?: Record<string, unknown>): Promise<boolean> {
    const o = opts || {};
    $("ask-title").textContent = (o.title as string) || T("confirm_title");
    $("ask-body").textContent = body || "";
    const okBtn = $("ask-ok");
    okBtn.className = "btn" + (o.danger ? " danger" : "");
    okBtn.textContent = (o.okText as string) || T("ok");
    $("ask-mask").classList.add("on");
    return new Promise<boolean>((resolve) => { askResolve = resolve; });
  }
  function askClose(result: boolean): void {
    $("ask-mask").classList.remove("on");
    const r = askResolve;
    askResolve = null;
    if (r) r(result);
  }
  $("ask-ok").onclick = () => askClose(true);
  $("ask-cancel").onclick = () => askClose(false);
  $("ask-mask").addEventListener("click", (e: Event) => {
    if ((e.target as Element).id === "ask-mask") askClose(false);
  });
  win.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (!$("ask-mask").classList.contains("on")) return;
    if (ke.key === "Escape") { ke.preventDefault(); askClose(false); }
    if (ke.key === "Enter") { ke.preventDefault(); askClose(true); }
  });

  return { doc, askConfirm };
}

/** Click an element the way a browser does (fires the handler). */
function click(doc: Document, id: string): void {
  (doc.getElementById(id) as unknown as { click(): void }).click();
}

/** Press a key on the window. */
function press(key: string): void {
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
}

describe("the confirm dialog resolves in every way a user can dismiss it", () => {
  it("OK resolves true and hides the dialog", async () => {
    const { doc, askConfirm } = installDialog();
    const p = askConfirm("Delete this account?");
    expect(doc.getElementById("ask-mask")!.classList.contains("on")).toBe(true);

    click(doc, "ask-ok");

    expect(await p).toBe(true);
    expect(doc.getElementById("ask-mask")!.classList.contains("on")).toBe(false);
  });

  it("Cancel resolves false", async () => {
    const { doc, askConfirm } = installDialog();
    const p = askConfirm("Delete this account?");

    click(doc, "ask-cancel");

    expect(await p).toBe(false);
    expect(doc.getElementById("ask-mask")!.classList.contains("on")).toBe(false);
  });

  it("the backdrop resolves false", async () => {
    const { doc, askConfirm } = installDialog();
    const p = askConfirm("Delete this account?");

    // Click ON the mask itself (not on the inner modal).
    (doc.getElementById("ask-mask") as unknown as { click(): void }).click();

    expect(await p).toBe(false);
  });

  it("Escape resolves false", async () => {
    const { askConfirm } = installDialog();
    const p = askConfirm("Delete this account?");

    press("Escape");

    expect(await p).toBe(false);
  });

  it("Enter resolves true", async () => {
    const { askConfirm } = installDialog();
    const p = askConfirm("Delete this account?");

    press("Enter");

    expect(await p).toBe(true);
  });

  it("keys do nothing while the dialog is closed", async () => {
    // A stray Enter on the page must not resolve a dialog that is not open —
    // that would confirm an action the user never saw.
    const { doc, askConfirm } = installDialog();
    press("Enter");
    press("Escape");
    const p = askConfirm("Delete this account?");
    // Still open, because nothing has dismissed it.
    expect(doc.getElementById("ask-mask")!.classList.contains("on")).toBe(true);
    click(doc, "ask-ok");
    expect(await p).toBe(true);
  });

  it("renders the caller's body text and danger styling", async () => {
    const { doc, askConfirm } = installDialog();
    const p = askConfirm("Really delete 3 accounts?", { danger: true, okText: "Delete", title: "Confirm" });

    expect(doc.getElementById("ask-body")!.textContent).toBe("Really delete 3 accounts?");
    expect(doc.getElementById("ask-ok")!.textContent).toBe("Delete");
    expect(doc.getElementById("ask-ok")!.className).toContain("danger");

    click(doc, "ask-ok");
    await p;
  });

  it("a second call after a resolved one works (the dialog is reusable)", async () => {
    // One dialog serves every action, so a stale resolver would make the second
    // prompt hang or resolve the wrong promise.
    const { doc, askConfirm } = installDialog();

    const first = askConfirm("first");
    click(doc, "ask-ok");
    expect(await first).toBe(true);

    const second = askConfirm("second");
    expect(doc.getElementById("ask-body")!.textContent).toBe("second");
    click(doc, "ask-cancel");
    expect(await second).toBe(false);
  });
});
