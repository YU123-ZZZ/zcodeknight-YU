/**
 * Guards for the Windows batch scripts.
 *
 * The .bat files are the first thing a user touches and the only part of the
 * project TypeScript never sees. Three of their failure modes are invisible in
 * an editor and only appear when cmd.exe runs them:
 *
 *   1. **Non-ASCII bytes.** cmd.exe parses a .bat using the console codepage
 *      (936/GBK on a Chinese Windows), not the file's actual encoding. A UTF-8
 *      Chinese comment therefore gets read as GBK, and one of those misread
 *      bytes lands on `&` -- which cmd treats as a command separator. The
 *      comment is then split in half and the tail is executed as a command.
 *      Observed: a `rem` line produced "'入口。' is not recognized as an
 *      internal or external command". A UTF-8 BOM does not rescue it either:
 *      cmd keeps the BOM and reports `'锘緻echo' is not recognized`.
 *      So .bat files here are ASCII-only, and the messages are English.
 *
 *   2. **LF line endings.** cmd.exe wants CRLF. With bare LF the last character
 *      of a line is frequently swallowed, which silently corrupts commands --
 *      the same class of damage as the earlier `.bat` with `!` under delayed
 *      expansion.
 *
 *   3. **A `call :label` with no matching label.** The call fails at runtime
 *      with "The system cannot find the batch label specified", deep enough into
 *      the script that it looks like the engine failed to stop.
 *
 * None of these can be caught by the TypeScript compiler, and all three are easy
 * to reintroduce with an editor that "helpfully" normalises line endings or a
 * comment written in Chinese. Hence this test.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo root: this file lives in server/src/. */
const ROOT = join(import.meta.dir, "..", "..");

const BATS = readdirSync(ROOT)
  .filter((f) => f.toLowerCase().endsWith(".bat"))
  .sort();

describe("batch scripts", () => {
  it("finds the expected scripts", () => {
    // A guard on the guard: if the walk ever finds nothing, every assertion
    // below would pass vacuously.
    //
    // The count is 3 rather than 4 because the clean copy deliberately drops
    // push-to-github.bat (see SKIP_FILES in build-clean-copy.ts): the copy has no
    // upstream repository to push to. This test runs in BOTH trees, so requiring
    // the full four would fail in the copy.
    expect(BATS).toContain("ZcodeKnight.bat");
    expect(BATS).toContain("setup.bat");
    expect(BATS).toContain("stop.bat");
    expect(BATS.length).toBeGreaterThanOrEqual(3);
  });

  it("are ASCII-only, so cmd.exe cannot misread them", () => {
    const bad: string[] = [];
    for (const f of BATS) {
      const bytes = readFileSync(join(ROOT, f));
      const offenders = [...bytes].filter((b) => b > 127);
      if (offenders.length > 0) {
        bad.push(`${f} (${offenders.length} byte(s) > 127, first at offset ${bytes.indexOf(offenders[0]!)})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("carry no UTF-8 BOM", () => {
    // cmd.exe does not strip it; the BOM becomes part of the first command and
    // `@echo off` fails, so every line is echoed instead of suppressed.
    const bad: string[] = [];
    for (const f of BATS) {
      const b = readFileSync(join(ROOT, f));
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  it("use CRLF line endings", () => {
    const bad: string[] = [];
    for (const f of BATS) {
      const text = readFileSync(join(ROOT, f), "utf-8");
      // A bare LF is any LF not preceded by CR.
      const bare = text.match(/[^\r]\n/g)?.length ?? 0;
      if (bare > 0) bad.push(`${f} (${bare} bare LF)`);
    }
    expect(bad).toEqual([]);
  });

  it("every call :label resolves to a real label", () => {
    // `call :foo` with no `:foo` fails at runtime, mid-script, which reads like
    // "the engine would not stop" rather than "the script has a typo".
    const bad: string[] = [];
    for (const f of BATS) {
      const text = readFileSync(join(ROOT, f), "utf-8");
      const called = new Set<string>();
      for (const m of text.matchAll(/\bcall\s+:([A-Za-z0-9_]+)/g)) called.add(m[1]!);
      if (called.size === 0) continue;
      const labels = new Set<string>();
      for (const m of text.matchAll(/^\s*:([A-Za-z0-9_]+)/gm)) labels.add(m[1]!);
      for (const c of called) {
        if (!labels.has(c)) bad.push(`${f}: call :${c} has no :${c} label`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("stop.bat identifies engines by their listening port, not by name alone", () => {
    // The engine binary can legitimately be named something else: a build writes
    // ZcodeKnight-new.exe before swapping it in, and a rollback copy keeps a
    // timestamped name. Matching image names exactly left those engines
    // invisible -- reproduced live with a running ZcodeKnight-new.exe that the
    // first version of this script could not find.
    const text = readFileSync(join(ROOT, "stop.bat"), "utf-8");
    expect(text).toContain("LISTENING");
    expect(text).toContain("127\\.0\\.0\\.1:");
    // Loose image matching, so renamed builds are still seen.
    expect(text).toMatch(/findstr \/i "ZcodeKnight"/);
    expect(text).toContain("runtime.exe");
  });

  it("stop.bat verifies the result instead of trusting taskkill", () => {
    // taskkill fails when the shell is not elevated. Reporting success from its
    // exit code would leave the operator thinking the port was free, and the
    // next thing they do is start a second engine -- on the same account store,
    // which is the one situation that silently loses accounts.
    const text = readFileSync(join(ROOT, "stop.bat"), "utf-8");
    expect(text).toContain("still running");
    expect(text).toContain("Administrator");
  });
});
