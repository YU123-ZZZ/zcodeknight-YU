/**
 * Behavioural tests for two playground bugs.
 *
 * ## 1. "Sending a message logs me out"
 *
 * `api()` treated every 401/403 as a lapsed panel session and re-gated the UI.
 * But the admin API also fronts the proxy, so an UPSTREAM refusal arrives down
 * the same channel: a risk-control block (3012) is answered with
 * `403 model_blocked_upstream`. Every send therefore popped the login dialog —
 * a symptom that reads exactly like a session bug and sends you hunting for one
 * that does not exist. The proxy has a 401 of its own too
 * (`start_plan_jwt_invalid`), so status alone can never decide.
 *
 * ## 2. "Refreshing loses the chat"
 *
 * The conversation lived in a plain in-memory array. For a page whose entire job
 * is verifying the chain end to end, discarding the evidence on refresh is the
 * wrong default, so it is kept in localStorage.
 *
 * Both are lifted out of the shipped panel and driven for real — a test that
 * restated the logic would keep passing after the panel changed.
 */
import { describe, it, expect } from "bun:test";
import { adminPanelHtml } from "./panel-html.js";

const html = adminPanelHtml();

/** Evaluate one function declaration from the panel and hand it back. */
function liftFunction<T>(name: string): T {
  const src = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(html);
  if (!src) throw new Error(`${name} not found in the panel`);
  // eslint-disable-next-line no-new-func
  return new Function(`${src[0]}\nreturn ${name};`)() as T;
}

describe("a 403 from the proxy is not a lapsed panel session", () => {
  const isSessionLapse = () => liftFunction<(r: Response) => Promise<boolean>>("isSessionLapse");

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("passes an upstream risk-control block through instead of re-gating", async () => {
    // The exact bug: this is what a 3012 looks like, and it must NOT show the
    // login dialog.
    const lapse = await isSessionLapse()(json(403, { error: { type: "model_blocked_upstream", message: "…" } }));
    expect(lapse).toBe(false);
  });

  it("passes an upstream 401 through too", async () => {
    // The proxy answers a dead start-plan JWT with 401, not the panel.
    const lapse = await isSessionLapse()(json(401, { error: { type: "start_plan_jwt_invalid" } }));
    expect(lapse).toBe(false);
  });

  it("still re-gates on our own two session failures", async () => {
    expect(await isSessionLapse()(json(401, { error: { type: "unauthorized" } }))).toBe(true);
    expect(await isSessionLapse()(json(403, { error: { type: "csrf_failed" } }))).toBe(true);
  });

  it("ignores statuses that cannot be a session verdict", async () => {
    expect(await isSessionLapse()(json(200, { ok: true }))).toBe(false);
    expect(await isSessionLapse()(json(500, { error: { type: "boom" } }))).toBe(false);
  });

  it("re-gates on an unrecognised 401/403 body rather than dead-ending the UI", async () => {
    // Against an older engine, or a non-JSON body, the conservative answer is to
    // ask for the key: never showing the dialog on a REAL lapse would strand the
    // operator on a page that silently stops working.
    const notJson = new Response("<html>proxy</html>", { status: 403 });
    expect(await isSessionLapse()(notJson)).toBe(true);
    expect(await isSessionLapse()(json(403, {}))).toBe(true);
  });
});

/**
 * Every declaration the playground persistence needs, lifted by NAME.
 *
 * Slicing between two textual markers was tried first and broke the moment a new
 * declaration was added outside the slice. Naming each one makes the extraction
 * independent of where in the file the block happens to sit.
 */
function pgSource(): string {
  const lift = (name: string, allowFn = false): string => {
    const re = allowFn
      ? new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m")
      : new RegExp(`^(?:const|let|var) ${name}\\b[^\\n]*;`, "m");
    const found = re.exec(html);
    if (!found) throw new Error(`${name} not found in the panel`);
    return found[0];
  };
  return [
    lift("PG_SEL"),
    lift("PG_STORE"),
    lift("pgHistory"),
    lift("pgRestored"),
    lift("pgPushTimer"),
    lift("PG_ROLES"),
    lift("pgBubbleClass", true),
    lift("pgSave", true),
    lift("pgSaveSelection", true),
    lift("pgLoadSelection", true),
    lift("pgSavedLocally", true),
    lift("pgPushToServer", true),
    lift("pgPaint", true),
    lift("pgRestore", true),
  ].join("\n");
}

describe("the playground conversation survives a refresh", () => {
  type PgApi = {
    pgSave(): void;
    pgRestore(): void | Promise<void>;
    history(): Array<{ role: string; content: string }>;
    setHistory(h: Array<{ role: string; content: string }>): void;
  };

  /**
   * The engine side of the store, as the panel sees it.
   *
   * `pgRestore` reads the transcript from `/playground/history` and falls back
   * to localStorage; `pgPushToServer` writes it back. Both go through `api()`,
   * so the harness supplies a fake whose behaviour the tests can steer — and
   * records what was sent, which is how "the transcript reached the engine" is
   * asserted rather than assumed.
   */
  type FakeApi = {
    fn: (path: string, opts?: { method?: string; body?: string }) => Promise<unknown>;
    /** Transcript the engine holds, or null for "unreachable". */
    server: { version: number; entries: Array<{ role: string; content: string }>; selection?: unknown } | null;
    /** Every body POSTed to /playground/history, in order. */
    posted: string[];
    /** Paths the panel called, in order. */
    calls: string[];
  };

  function fakeApi(initial: FakeApi["server"] = { version: 1, entries: [] }): FakeApi {
    const state: FakeApi = {
      server: initial,
      posted: [],
      calls: [],
      fn: async (path, opts) => {
        state.calls.push((opts && opts.method) || "GET");
        if (path === "/playground/history" && (!opts || !opts.method || opts.method === "GET")) {
          if (state.server === null) throw new Error("engine unreachable");
          return { json: async () => state.server };
        }
        if (path === "/playground/history" && opts.method === "POST") {
          state.posted.push(opts.body ?? "");
          if (state.server === null) throw new Error("engine unreachable");
          state.server = JSON.parse(opts.body ?? "{}");
          return { json: async () => state.server };
        }
        if (path === "/playground/history/clear") {
          state.server = { version: 1, entries: [] };
          return { json: async () => ({ ok: true }) };
        }
        return { json: async () => ({}) };
      },
    };
    return state;
  }

  function build(storage: unknown, chatBubble: unknown, api: FakeApi["fn"]): PgApi {
    // eslint-disable-next-line no-new-func
    return (new Function(
      "localStorage", "chatBubble", "api", "setTimeout", "clearTimeout",
      `${pgSource()}\nreturn { pgSave, pgRestore, history: () => pgHistory, setHistory: (h) => { pgHistory = h; } };`,
    ) as (s: unknown, c: unknown, a: unknown, st: unknown, ct: unknown) => PgApi)(
      storage, chatBubble, api,
      // The upload is debounced with setTimeout; the harness runs it inline so
      // a test does not have to wait on a timer to observe the POST.
      (fn: () => void) => { fn(); return 0; },
      () => {},
    );
  }

  function harness(store: Record<string, string> = {}, server?: FakeApi["server"]) {
    const painted: Array<{ cls: string; text: string }> = [];
    const fakeStorage = {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    const api = fakeApi(server);
    const pg = build(fakeStorage, (cls: string, text: string) => { painted.push({ cls, text }); }, api.fn);
    return { api: pg, painted, store, net: api };
  }

  /** `pgRestore` is async now — the engine is asked before localStorage. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("writes the conversation and repaints it in order", async () => {
    const { api, painted, store, net } = harness();
    api.setHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    api.pgSave();
    // Both copies are written: the engine's is the source of truth, the
    // browser's is the fallback for an unreachable engine.
    expect(store["zk-pg-history"]).toContain("hi there");
    expect(net.posted.length).toBe(1);
    expect(JSON.parse(net.posted[0]!).entries).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);

    // A fresh page load sees the same conversation, in order, with the right
    // bubble class on each side. Its localStorage is empty on purpose: the
    // engine's copy alone has to be enough.
    const reloaded = harness({}, { version: 1, entries: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ] });
    await reloaded.api.pgRestore();
    await settle();
    expect(reloaded.api.history()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(reloaded.painted).toEqual([
      { cls: "user", text: "hello" },
      { cls: "bot", text: "hi there" },
    ]);
  });

  it("reads the engine's copy, not the browser's, when both exist", async () => {
    // The two can disagree: the engine's file survives a browser profile reset
    // and is the copy that clearing data/ removes. If localStorage won, a
    // cleared transcript would come back from the browser and the clear button
    // would look broken.
    const { api, painted } = harness(
      { "zk-pg-history": '[{"role":"user","content":"stale browser copy"}]' },
      { version: 1, entries: [{ role: "user", content: "engine copy" }] },
    );
    await api.pgRestore();
    await settle();
    expect(painted).toEqual([{ cls: "user", text: "engine copy" }]);
  });

  it("falls back to the browser copy when the engine is unreachable", async () => {
    const { api, painted } = harness(
      { "zk-pg-history": '[{"role":"user","content":"offline copy"}]' },
      null, // unreachable
    );
    await api.pgRestore();
    await settle();
    expect(painted).toEqual([{ cls: "user", text: "offline copy" }]);
  });

  it("uploads a transcript that only the browser had", async () => {
    // The migration case: a conversation written before this moved server-side
    // exists only in localStorage. Restoring it must push it to the engine, or
    // the next clear would still leave it behind.
    const { api, net } = harness(
      { "zk-pg-history": '[{"role":"user","content":"pre-migration"}]' },
      { version: 1, entries: [] },
    );
    await api.pgRestore();
    await settle();
    expect(net.posted.length).toBe(1);
    expect(JSON.parse(net.posted[0]!).entries).toEqual([{ role: "user", content: "pre-migration" }]);
  });

  it("restores only once, so re-entering the page cannot duplicate the chat", async () => {
    const reloaded = harness({}, { version: 1, entries: [{ role: "user", content: "once" }] });
    await reloaded.api.pgRestore();
    await reloaded.api.pgRestore();
    await reloaded.api.pgRestore();
    await settle();
    expect(reloaded.painted.length).toBe(1);
  });

  it("repaints the saved errors as error bubbles after a refresh", async () => {
    // The restore path must handle the third role, or a refresh would drop the
    // failure lines it just learned to save.
    const reloaded = harness({}, { version: 1, entries: [
      { role: "user", content: "hello" },
      { role: "error", content: "HTTP 403 · blocked" },
      { role: "assistant", content: "hi" },
    ] });
    await reloaded.api.pgRestore();
    await settle();
    expect(reloaded.painted.map((p) => p.cls)).toEqual(["user", "err", "bot"]);
    expect(reloaded.api.history().length).toBe(3);
  });

  it("drops entries the engine could not accept", async () => {
    // The list arrives from the engine's JSON file or from localStorage, both
    // editable; a bad entry would otherwise be replayed upstream as a malformed
    // message.
    const { api, painted } = harness({}, { version: 1, entries: [
      { role: "user", content: "keep me" },
      { role: "system", content: "not a chat role" },
      { role: "assistant", content: undefined as unknown as string },
      { content: "no role" } as unknown as { role: string; content: string },
      null as unknown as { role: string; content: string },
      { role: "assistant", content: "keep me too" },
    ] });
    await api.pgRestore();
    await settle();
    expect(api.history()).toEqual([
      { role: "user", content: "keep me" },
      { role: "assistant", content: "keep me too" },
    ]);
    expect(painted.length).toBe(2);
  });

  it("starts empty on a corrupt or unreadable value instead of throwing", () => {
    const { api, painted } = harness({ "zk-pg-history": "{not json" });
    api.pgRestore();
    expect(api.history()).toEqual([]);
    expect(painted.length).toBe(0);
  });

  it("sending still works when localStorage refuses (private mode)", async () => {
    // Losing the saved copy must never break the send path. The engine write is
    // the one that matters now, so its failure is covered too.
    const hostile = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    const dead = fakeApi(null); // engine unreachable as well
    const api = build(hostile, () => {}, dead.fn);
    api.setHistory([{ role: "user", content: "still sent" }]);
    expect(() => api.pgSave()).not.toThrow();
    expect(() => api.pgRestore()).not.toThrow();
    await settle();
    expect(api.history().length).toBe(1);
  });
});

describe("a model switch is noted in the transcript", () => {
  /**
   * `pgNoteSwitch` plus the state it needs, driven with a stubbed T/chatBubble.
   *
   * Comparing two models' answers is the main reason to switch mid-conversation,
   * and the comparison is unreadable afterwards unless the transcript says where
   * the change happened — the reply after the note came from a different model.
   */
  function noteHarness() {
    const painted: Array<{ cls: string; text: string }> = [];
    const store: Record<string, string> = {};
    // pgHistory + pgSave + pgNoteSwitch must share ONE closure: pgSave reads the
    // pgHistory it was compiled with, so injecting them as separate snippets
    // leaves the note pushing into an array that nothing persists.
    const block = pgSource() + "\n" + (/function pgNoteSwitch\(from, to\) \{[\s\S]*?\n\}/.exec(html)?.[0] ?? "");
    if (!block.includes("pgNoteSwitch")) throw new Error("pgNoteSwitch not found in the panel");
    // eslint-disable-next-line no-new-func
    const make = new Function(
      "localStorage", "chatBubble", "T",
      `${block}\nreturn { pgNoteSwitch, history: () => pgHistory };`,
    ) as (s: unknown, c: unknown, t: unknown) => {
      pgNoteSwitch(from: string, to: string): void;
      history(): Array<{ role: string; content: string }>;
    };
    return {
      api: make(
        {
          getItem: (k: string) => (k in store ? store[k]! : null),
          setItem: (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
        },
        (cls: string, text: string) => painted.push({ cls, text }),
        (k: string) => (k === "pg_switched" ? "模型已从 {from} 切换为 {to}" : k),
      ),
      painted,
      store,
    };
  }

  it("records and displays the switch with both model names", () => {
    const h = noteHarness();
    h.api.pgNoteSwitch("glm-5.3", "glm-5.3-flash");
    expect(h.painted).toEqual([{ cls: "note", text: "模型已从 glm-5.3 切换为 glm-5.3-flash" }]);
    expect(h.api.history()).toEqual([
      { role: "note", content: "模型已从 glm-5.3 切换为 glm-5.3-flash" },
    ]);
    // Persisted, so a refresh still shows where the change happened.
    expect(h.store["zk-pg-history"]).toContain("glm-5.3-flash");
    expect(JSON.parse(h.store["zk-pg-history"]!)).toEqual([
      { role: "note", content: "模型已从 glm-5.3 切换为 glm-5.3-flash" },
    ]);
  });

  it("says nothing when there is nothing to say", () => {
    // A no-op switch (re-picking the same model, or the first default) must not
    // clutter the transcript.
    const h = noteHarness();
    h.api.pgNoteSwitch("glm-5.3", "glm-5.3");
    h.api.pgNoteSwitch("", "glm-5.3");
    h.api.pgNoteSwitch("glm-5.3", "");
    expect(h.painted).toEqual([]);
    expect(h.api.history()).toEqual([]);
  });

  it("is excluded from the payload sent upstream", () => {
    // The model API accepts only user/assistant, so a `note` row must be
    // filtered out — same rule as the `error` rows.
    const filter = /messages: pgHistory\.filter\(\(m\) => m\.role === "user" \|\| m\.role === "assistant"\)/.exec(html);
    expect(filter).not.toBeNull();
  });

  it("repaints as a divider, not as something either side said", () => {
    expect(html).toContain(".msg.note {");
    const cls = /function pgBubbleClass\(role\) \{[\s\S]*?\n\}/.exec(html);
    expect(cls).not.toBeNull();
    expect(cls![0]).toContain('role === "note" ? "note"');
    // And the role must survive the restore filter.
    const roles = /const PG_ROLES = new Set\(\[([^\]]*)\]\)/.exec(html);
    expect(roles).not.toBeNull();
    expect(roles![1]).toContain('"note"');
  });

  it("is wired to the picker's own change event", () => {
    // The picker dispatches `change` on the hidden input, which is what makes
    // this work for a hand-picked model.
    const wiring = /getElementById\("pg-model"\)\.addEventListener\("change"[\s\S]*?pgLastModel = now;/.exec(html);
    expect(wiring).not.toBeNull();
    expect(wiring![0]).toContain("pgNoteSwitch(pgLastModel, now)");
  });

  it("declares pgLastModel before anything can read it", () => {
    // It is read by loadPlaygroundAccounts(), which runs on a language switch and
    // at boot. Declaring it after that function put it in the temporal dead zone
    // and would throw on the first paint.
    const decl = html.indexOf("let pgLastModel");
    const use = html.indexOf("pgLastModel = document.getElementById");
    const fn = html.indexOf("async function loadPlaygroundAccounts");
    expect(decl).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(fn);
    expect(decl).toBeLessThan(use);
  });
});
  /**
   * Lifts the whole send path — state, save/restore, the bubble helper and
   * pgSend — with `document`, `api` and the network bits injected.
   *
   * This is the regression the user actually hit: the failure branch popped the
   * user's message back off and re-saved, so while upstream was blocking (3012)
   * EVERY attempt saved the message and then immediately saved an empty list
   * over it. Nothing ever survived a refresh, which read as "chat history does
   * not work" — while on screen the message was still there, because the bubble
   * is drawn before the request is even sent.
   */
  function sendHarness() {
    const store: Record<string, string> = {};
    const painted: Array<{ cls: string; text: string; el: unknown }> = [];
    const fakeEl = () => ({ textContent: "", prepend() {}, remove() {} });

    const make = (okResponse: unknown) => {
      const send = /^(?:async )?function pgSend\([\s\S]*?\n\}/m.exec(html);
      if (!send) throw new Error("pgSend not found in the panel");

      // Everything the panel would have posted upstream, so a test can prove the
      // saved `error` rows never travel as messages.
      const sent: Array<{ messages: Array<{ role: string; content: string }> }> = [];

      const chatBubble = (cls: string, text: string) => {
        const el = fakeEl();
        painted.push({ cls, text, el });
        return el;
      };
      const inputs: Record<string, { value: string }> = {
        "pg-input": { value: "hello" },
        "pg-model": { value: "glm-5.3" },
        "pg-account": { value: "" },
      };
      const document = { getElementById: (id: string) => inputs[id] ?? null };
      const api = async (_path: string, opts: { body?: string }) => {
        sent.push(JSON.parse(opts?.body ?? "{}"));
        return okResponse;
      };

      // eslint-disable-next-line no-new-func
      const fn = (new Function(
        "document", "localStorage", "chatBubble", "api", "TextDecoder",
        `${pgSource()}\n${send[0]}
         return { pgSend, history: () => pgHistory };`,
      ) as (...a: unknown[]) => { pgSend(): Promise<void>; history(): Array<{ role: string; content: string }> })(
        document, {
          getItem: (k: string) => (k in store ? store[k]! : null),
          setItem: (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
        },
        chatBubble,
        api,
        TextDecoder,
      );
      return { fn, store, painted, inputs, sent };
    };

    return { make };
  }

describe("the picker choices survive a refresh", () => {
  /**
   * Neither the model nor the account used to be remembered, so every reload
   * re-seeded the model to the FIRST entry of the list: pick `glm-5.3-flash`,
   * refresh, and you are back on `glm-5.3`. The conversation itself IS restored,
   * so the transcript came back with a selector that disagreed with the replies
   * already in it.
   */
  function selHarness(store: Record<string, string> = {}, values: Record<string, string> = {}) {
    const els: Record<string, { value: string }> = {
      "pg-model": { value: values.model ?? "" },
      "pg-account": { value: values.account ?? "" },
    };
    const document = { getElementById: (id: string) => els[id] ?? null };
    const src = pgSource();
    if (!src.includes("pgSaveSelection")) throw new Error("pgSaveSelection not lifted — check pgSource()");
    // eslint-disable-next-line no-new-func
    const make = new Function(
      "document", "localStorage",
      `${src}\nreturn { pgSaveSelection, pgLoadSelection };`,
    ) as (d: unknown, s: unknown) => {
      pgSaveSelection(): void;
      pgLoadSelection(): { model: string; account: string };
    };
    return {
      api: make(document, {
        getItem: (k: string) => (k in store ? store[k]! : null),
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      }),
      els,
      store,
    };
  }

  it("round-trips the model and the account", () => {
    const h = selHarness({}, { model: "glm-5.3-flash", account: "acc-2" });
    h.api.pgSaveSelection();
    expect(JSON.parse(h.store["zk-pg-select"]!)).toEqual({ model: "glm-5.3-flash", account: "acc-2" });
    // A fresh page reads the same pair back.
    expect(selHarness(h.store).api.pgLoadSelection()).toEqual({ model: "glm-5.3-flash", account: "acc-2" });
  });

  it("reports empty selections rather than throwing on a fresh install", () => {
    expect(selHarness().api.pgLoadSelection()).toEqual({ model: "", account: "" });
    expect(selHarness({ "zk-pg-select": "{corrupt" }).api.pgLoadSelection()).toEqual({ model: "", account: "" });
  });

  it("a stale stored model is not restored", () => {
    // The model list comes from probe results, so a stored model can vanish when
    // an account is removed. Restoring it blindly would caption the picker with
    // a model the pool cannot call.
    const restore = /const sel = pgLoadSelection\(\);[\s\S]*?setPickerValue\("pg-model", models\[0\]\);/.exec(html);
    expect(restore).not.toBeNull();
    expect(restore![0]).toContain("models.includes(sel.model)");
    // And the account is matched against the ids actually in the pool.
    expect(html).toContain("acc.some((a) => a.id === sel.account)");
  });

  it("saving the conversation also saves the selection", () => {
    // Otherwise the pair could drift: the transcript restores but the selector
    // does not, which is the bug this fixes.
    const save = /function pgSave\(\) \{[\s\S]*?\n\}/.exec(html);
    expect(save).not.toBeNull();
    expect(save![0]).toContain("pgSaveSelection()");
  });

  it("changing either picker saves the selection", () => {
    expect(html).toMatch(/pgLastModel = now;\s*\n\s*pgSaveSelection\(\);/);
    expect(html).toMatch(/getElementById\("pg-account"\)\.addEventListener\("change", pgSaveSelection\)/);
  });
});

describe("a failed send keeps the message that is on screen", () => {
  it("keeps the message AND the failure text when the request errors", async () => {
    const h = sendHarness().make({ ok: false, status: 403, text: async () => '{"error":{"type":"model_blocked_upstream"}}' });
    await h.fn.pgSend();

    // On screen: the user's bubble plus an error bubble.
    expect(h.painted.map((p) => p.cls)).toEqual(["user", "bot", "err"]);
    // Saved: what is on screen. The failure text is included on purpose — it is
    // the evidence of what happened, and the thing most worth finding after a
    // refresh while upstream is refusing everything.
    expect(h.fn.history()).toEqual([
      { role: "user", content: "hello" },
      { role: "error", content: expect.stringContaining("HTTP 403") },
    ]);
    // And it must NOT be sent upstream as a message.
    expect(h.sent[0]!.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("keeps the message and the failure text when the transport dies mid-stream", async () => {
    const built = sendHarness().make({
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error("socket died"); } }) },
    });
    await built.fn.pgSend();
    expect(built.fn.history()).toEqual([
      { role: "user", content: "hello" },
      { role: "error", content: "Error: socket died" },
    ]);
    expect(built.sent[0]!.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("appends the answer when the request succeeds", async () => {
    // The success path must still record both sides.
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      "data: [DONE]\n",
    ];
    let i = 0;
    const resp = {
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]!) } : { done: true }) }) },
    };
    const h = sendHarness().make(resp);
    await h.fn.pgSend();
    expect(h.fn.history()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
});

/**
 * The clear button must clear the ENGINE's copy, not just the browser's.
 *
 * This is the bug that prompted storing the transcript server-side at all:
 * clearing removed the localStorage entry and left `data/playground.json`
 * untouched, so the conversation came back on the next page load from the copy
 * that was never cleared. Reading the panel source is the only way to check
 * this from a test — the handler is an inline DOM assignment, not an exported
 * function.
 */
describe("clearing the transcript clears the stored copy", () => {
  const handler = (): string => {
    const m = /document\.getElementById\("pg-clear"\)\.onclick = async \(\) => \{[\s\S]*?\n\};/.exec(html);
    if (!m) throw new Error("the pg-clear handler was not found in the panel");
    return m[0];
  };

  it("calls the engine's clear endpoint", () => {
    expect(handler()).toContain("/playground/history/clear");
  });

  it("cancels an upload that has not fired yet", () => {
    // Without this the debounced POST from the message just before the clear
    // lands moments later and puts the transcript back on the engine.
    const h = handler();
    expect(h).toContain("pgPushTimer");
    expect(h).toContain("clearTimeout");
  });

  it("still clears the browser copy", () => {
    expect(handler()).toContain("localStorage.removeItem(PG_STORE)");
  });

  it("does not let a failed engine call leave the button stuck", () => {
    // The engine may be unreachable; the local copy is gone either way, so the
    // call must be allowed to reject without taking the handler down.
    expect(handler()).toContain(".catch(");
  });
});
