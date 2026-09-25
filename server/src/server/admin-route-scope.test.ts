/**
 * Guard: a module-level function in routes-admin must RECEIVE `config`, not
 * reference one from nowhere.
 *
 * This is not hypothetical. `resolveLoginSession()` is declared at module level
 * and its signature took only (session, name). The probe that runs after a
 * successful OAuth login referenced `config` anyway — and because that reference
 * sat inside a `.then()` callback, the resulting ReferenceError was swallowed by
 * the trailing `.catch()`: the probe silently never ran and left one warn line,
 * which is why nobody noticed for as long as accounts kept being added.
 *
 * Then the probe gained a gate, `if (config.probe.enabled && ...)`, which
 * evaluates in the FUNCTION BODY rather than inside a promise. The same
 * undefined reference now threw synchronously, with no catch in the way, and
 * took the whole login down: reported as "登录失败: config is not defined".
 *
 * A type checker cannot catch it because `config` may be in scope somewhere else
 * in the file. This scan can: for every top-level function, a `config` reference
 * must resolve to either a parameter or a local declaration.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "routes-admin.ts"), "utf-8");

/** Body of the top-level function whose `function` keyword sits at `at`. */
function bodyOf(at: number): string {
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  return SRC.slice(open);
}

/** Top-level function declarations: name + parameter list + body. */
function topLevelFunctions(): Array<{ name: string; params: string; body: string }> {
  const out: Array<{ name: string; params: string; body: string }> = [];
  const re = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    out.push({ name: m[1]!, params: m[2]!, body: bodyOf(m.index) });
  }
  return out;
}

/** `config` in scope by declaration rather than by parameter. */
function declaresConfig(body: string): boolean {
  return /\b(?:const|let|var)\s+config\b/.test(body)      // const config = …
    || /\b(?:const|let|var)\s*\{[^}]*\bconfig\b[^}]*\}/.test(body); // const { config } = …
}

/** `config` used as a bare identifier — not `opts.config`, not `cfg.config`. */
function bareConfigUses(body: string): number {
  return [...body.matchAll(/(^|[^.\w$])config\b/g)].length;
}

describe("admin route module scope", () => {
  it("has top-level functions to check at all", () => {
    // Guards the guard: an empty list would make the assertion below vacuous.
    expect(topLevelFunctions().length).toBeGreaterThan(3);
  });

  it("every top-level function that uses config receives or declares it", () => {
    const offenders: string[] = [];
    for (const fn of topLevelFunctions()) {
      if (bareConfigUses(fn.body) === 0) continue;
      if (/\bconfig\b/.test(fn.params)) continue;
      if (declaresConfig(fn.body)) continue;
      offenders.push(`${fn.name}(${fn.params.trim() || "no params"}) — uses config but never receives it`);
    }
    expect(offenders).toEqual([]);
  });

  it("resolveLoginSession is handed the config it needs", () => {
    // The specific crash: this function must take config, because it now
    // evaluates a probe gate synchronously.
    const fn = topLevelFunctions().find((f) => f.name === "resolveLoginSession");
    expect(fn).toBeDefined();
    expect(/\bconfig\b/.test(fn!.params)).toBe(true);
    // And the call site must actually pass it.
    expect(SRC).toMatch(/resolveLoginSession\(session,\s*body\?\.name,\s*config\)/);
  });
});
