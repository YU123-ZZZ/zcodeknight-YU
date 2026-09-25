/**
 * Build the clean copy of this project.
 *
 * The copy is for private use and must carry NO attribution: no copyright
 * headers, no disclaimers, no donation QR, no contact links, no author profile,
 * and no markdown at all. It is otherwise the same working engine.
 *
 * Rules, applied in this order:
 *   1. Copy the project, skipping .git, data, node_modules, _reverse, and the
 *      runtime binary (the launcher fetches or finds one).
 *   2. Delete every .md and the donation assets.
 *   3. Strip the copyright/disclaimer block from every text file, in both
 *      languages, including the AI-facing notice.
 *   4. Remove the panel's footer attribution (the 交流群, author link, 52pojie
 *      link and the "free of charge" line) so nothing on screen points home.
 *
 * Idempotent: re-running rebuilds the copy from the current source.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { join, relative, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source tree this script copies FROM.
 *
 * Derived from this file's own location (`<root>/server/build-clean-copy.ts`)
 * rather than written as an absolute path: the project has to work after being
 * copied to another drive or machine, and a hardcoded `D:/...` made the script
 * fail there with a confusing ENOENT. `ZCODE_KNIGHT_SRC` overrides it for the
 * unusual case of building a copy from somewhere else.
 */
const SRC = process.env.ZCODE_KNIGHT_SRC?.trim()
  || resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the copy is written.
 *
 * A SIBLING of the project, deliberately not nested inside it. A copy under the
 * project would be walked into itself on a rebuild — the file walk reads from
 * SRC while writing into DEST.
 *
 * `ZCODE_KNIGHT_DEST` overrides it.
 */
const DEST = process.env.ZCODE_KNIGHT_DEST?.trim()
  || join(dirname(SRC), basename(SRC) + "-clean");

// `_reverse` holds reverse-engineering notes plus a 313 MB copy of the ZCode
// client. It is not part of the engine, the source tree's own .gitignore calls
// the client copy 他人版权作品, and the notes are .md — so the whole directory is
// excluded rather than shipped in a copy whose point is to be clean.
const SKIP_DIRS = new Set([".git", "data", "node_modules", "workspace", "dist", "build", "__pycache__", "docs", "_reverse",
  // The brand mark's icon set (icons/ZcodeKnight.ico) and the logo itself are
  // the author's artwork. The clean copy ships without them by request, which
  // is why the panel markup is rewritten (stripLogo) rather than left pointing
  // at a file that is not there.
  "icons"]);
const SKIP_FILES = new Set([
  // The engine binaries are NOT copied by the walk — they are built afterwards
  // by buildEngine() below, which is what makes the copy runnable the moment it
  // is generated. Copying the source tree's .exe would ship a binary built from
  // different sources, which is worse than building it here.
  "ZcodeKnight.exe", "runtime.exe", "runtime", "runtime.exe.bak", "runtime.bak",
  "push-to-github.bat", "LICENSE", "策划方案.md",
  "add-copyright-header.mjs", "build-clean-copy.ts", "prepare-docker.ts",
  // The brand mark: not copied, and the panel is rewritten to not need it.
  "logo.svg",
  // Gitignored in the source for a reason: it carries the proxy key and the
  // device identity. Shipping it would hand out this machine's credentials and
  // make every copy of the clean tree share one device fingerprint. The engine
  // writes a fresh template config on first run, which is what a copy wants.
  "config.yaml",
]);
/**
 * Name patterns skipped from the copy because they hold live state, not source.
 *
 * The export/backup files the panel writes (`backup-before-delete-*.json`,
 * `zcodeknight-alldata-*.json`) are a dump of the account store — the same
 * encrypted blob `data/accounts.json` holds, which decrypts with this machine's
 * KDF seed. They are gitignored in the source tree for exactly that reason, but
 * `SKIP_FILES` matches whole names only, so the walk carried them straight into
 * the clean copy: the "clean" tree ended up shipping the operator's accounts to
 * whatever machine it was taken to. Matched by pattern because the names carry
 * a timestamp.
 */
const SKIP_PATTERNS: RegExp[] = [
  /^backup-before-delete-.*\.json$/i,
  /^zcodeknight-alldata-.*\.json$/i,
  /^zcodeknight-logs-.*\.csv$/i,
];
/**
 * Extensions skipped from the copy.
 *
 * `.ico` is NOT here: the app icon is generated from this project's own logo
 * (see scripts/make-icon.ts) and carries no attribution, so the copy needs it
 * for its shortcut to show the knight helm instead of a generic gear. The
 * raster formats stay excluded — those are screenshots and the donation QR.
 */
const SKIP_EXT = new Set([".md", ".pyc", ".png", ".jpg", ".jpeg", ".log", ".zip", ".bak", ".asar"]);

/**
 * True for any build of the engine itself.
 *
 * The copy builds its own engine, so shipping one from the source tree would
 * ship a binary made from different code — and it is ~89 MB. Matching exact
 * names was not enough: the walk only skipped `ZcodeKnight.exe`, so a rollback
 * copy kept beside it (`ZcodeKnight.exe.old-<stamp>`, which `bun build` and the
 * swap logic both produce) plus the platform/temp builds
 * (`ZcodeKnight-new.exe`, `ZcodeKnight-YU.exe`, `ZcodeKnight-linux-x64`) all
 * travelled into the copy. An 89 MB stale binary then sat there, and its
 * presence alone made the copy report "the copy is running".
 */
function isEngineBinary(base: string): boolean {
  // ZcodeKnight.exe, ZcodeKnight.exe.old-20260923-172316, ZcodeKnight.exe.<ms>
  if (base === "ZcodeKnight.exe" || base.startsWith("ZcodeKnight.exe.")) return true;
  // ZcodeKnight-new.exe, ZcodeKnight-YU.exe, ZcodeKnight-linux-x64.exe
  return /^ZcodeKnight[-.].*\.exe$/i.test(base);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

// ── 1. copy ───────────────────────────────────────────────────────────────────
// Clear the tree's CONTENTS rather than removing the root directory. On Windows
// a handle on the root itself (indexer, Defender, a shell whose cwd is inside)
// makes `rm -rf` on the root fail with EBUSY no matter how long you retry, while
// the children delete fine. Keeping the root also means the copy is rebuilt in
// place, so an editor or terminal pointed at it does not lose its footing.
/**
 * Runtime state inside DEST that must SURVIVE a rebuild.
 *
 * The copy is a live deployment, not a build artifact: once the operator adds
 * accounts, `data/` holds the only copy of their encrypted credentials. Wiping
 * it turned "rebuild the copy" into "delete every account" — the store was gone
 * after a rebuild and the engine came up with an empty pool.
 *
 * These are exactly the paths the file walk skips (SKIP_DIRS), so preserving
 * them cannot let a source-tree file leak into the copy.
 */
// `workspace` is listed for old copies: it was the remote-control sandbox and
// that feature is gone, so the engine no longer writes there, but a copy made
// before its removal still has one and a rebuild must not delete it.
const PRESERVE_IN_DEST = new Set(["data", "workspace", "config", "node_modules"]);

function wipe(dir: string): void {
  if (!existsSync(dir)) return;
  // Retry the whole PASS, not each child: a handle released mid-pass can free a
  // child that already failed, so a second sweep often succeeds where per-child
  // retries had given up.
  let lastErr: unknown;
  for (let pass = 1; pass <= 6; pass++) {
    lastErr = undefined;
    for (const e of readdirSync(dir)) {
      if (PRESERVE_IN_DEST.has(e)) continue;
      try {
        rmSync(join(dir, e), { recursive: true, force: true });
      } catch (err) {
        lastErr = err;
      }
    }
    if (!lastErr) return;
    Bun.sleepSync(700);
  }
  // A running engine holds its own executable open, so the copy cannot be
  // deleted while it is serving. That is the normal case for a rebuild — the
  // operator is usually running the copy they are about to replace — so a
  // locked .exe is reported and skipped rather than aborting the whole build.
  // Everything else must still clear, or a stale file would survive into the
  // "clean" tree, which is the one thing this script exists to prevent.
  if (isLockedExe(lastErr)) {
    const locked = readdirSync(dir).filter((e) => e.toLowerCase().endsWith(".exe"));
    // A running engine cannot be deleted, but it CAN be renamed on Windows.
    // Move it aside so the new binary has a free path; the running process
    // keeps serving from the renamed file.
    for (const e of locked) {
      try { rmSync(join(dir, e), { force: true }); } catch {
        try { renameSync(join(dir, e), join(dir, `${e}.old`)); } catch { /* leave it */ }
      }
    }
    console.log(`! 副本的引擎正在运行，旧二进制已改名保留：${locked.join(", ")}`);
    return;
  }
  if (lastErr) throw lastErr;
}

/**
 * True when the failure is a running executable holding its own image open.
 *
 * Matches any `.exe`-derived name, not just one ending in `.exe`: a rebuild that
 * had to move a running engine aside leaves `ZcodeKnight.exe.old.<timestamp>`,
 * and that file is locked by the very process still serving from it. Testing
 * only for a `.exe` suffix made the next rebuild abort on a file this script
 * itself created.
 */
function isLockedExe(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const path = String((err as { path?: string })?.path ?? "").toLowerCase();
  return (code === "EPERM" || code === "EBUSY" || code === "EACCES")
    && (path.endsWith(".exe") || path.includes(".exe."));
}
wipe(DEST);
mkdirSync(DEST, { recursive: true });

let copied = 0;
let skipped = 0;
for (const f of walk(SRC)) {
  const base = f.split(/[\\/]/).pop() || "";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
  if (SKIP_FILES.has(base) || SKIP_EXT.has(ext) || isEngineBinary(base)
      || SKIP_PATTERNS.some((re) => re.test(base))) { skipped++; continue; }
  const rel = relative(SRC, f);
  const to = join(DEST, rel);
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(f, to);
  copied++;
}
console.log(`复制 ${copied} 个文件，跳过 ${skipped} 个`);

// ── 2 & 3. strip attribution ──────────────────────────────────────────────────
/**
 * Remove attribution lines from a file's LEADING comment region.
 *
 * Three shapes exist in this tree, and all three must be handled or a file keeps
 * a link home:
 *   - a `/** ... *\/` block (most .ts files);
 *   - that block preceded by a `// @ts-nocheck` line (captcha-happy.ts);
 *   - plain `//` / `rem` / `#` line comments (.txt panel, .bat, .sh).
 *
 * Only the leading region is eligible, so a docstring further down that mentions
 * the author in prose is not touched by accident.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /作者\s*Author|Author:\s*YU123|作者\s*Author/,
  /52pojie|吾爱破解/,
  /QQ Group|交流群|1091692024/,
  /本项目完全开源|完全开源免费|收费的一律是骗子|收费的都是骗子|完全开源免费 · 收费的都是骗子/,
  /二次分发|原作者版权注释|非官方修改版|冒充作者最终版本/,
  /均非本项目官方授权|均不代表作者官方作品|官方收费版本/,
  /未经作者允许|AI 助手的内置提示词|AI assistants|commercial resale|Preserve this notice/,
  /Black Knight Gateway|黑骑士网关/,
  /This project is fully open source and free of charge|fully open source and free of charge/,
  /YU123-ZZZ/,
  /^[─=\-]{6,}$/,
];

function isAttribution(line: string): boolean {
  const t = line.replace(/^[ \t]*(?:\/\/|rem\s|#|\*|\/\*\*?|\*\/|<!--|-->)?[ \t]*/i, "").trim();
  if (!t) return false;               // blank lines are structural, not attribution
  if (t === "/**" || t === "/*" || t === "*/") return false;  // markers are structural
  return ATTRIBUTION_PATTERNS.some((re) => re.test(t));
}

/**
 * Strip attribution while preserving comment STRUCTURE.
 *
 * Removing lines naively broke real files: a file with two stacked blocks (an
 * attribution header followed by a docstring) lost the opening `/**` of one and
 * the closing `*\/` of the other, leaving a dangling fragment that no longer
 * parsed. So the leading region is parsed into whole comment blocks, and a block
 * that carries ANY attribution is removed entire — delimiters included.
 *
 * The verdict is per block, not per line, because the disclaimer is prose
 * wrapped across many lines: only the first line of each sentence carries a
 * recognised token, so a per-line filter leaves orphans like "的内容外，任何桌面
 * 软件…" behind. Blocks are separated by blank lines, which is what keeps a real
 * docstring that sits below the attribution.
 */
function stripHeader(text: string): { out: string; changed: boolean } {
  // Cheap bail-out: most files carry no attribution at all.
  if (!["YU123-ZZZ", "52pojie", "1091692024", "本项目完全开源", "Black Knight Gateway", "黑骑士网关"]
    .some((m) => text.includes(m))) {
    return { out: text, changed: false };
  }
  const lines = text.split(/\r?\n/);
  const SKIP_FIRST = /^[ \t]*(#!|@echo|<!doctype|chcp\b)/i;
  let start = 0;
  if (lines.length && SKIP_FIRST.test(lines[0])) start = 1;

  const isLineComment = (l: string) => /^[ \t]*(\/\/|rem\b|#)/i.test(l);
  const blocks: Array<{ from: number; to: number }> = [];
  let regionEnd = start - 1;
  let i = start;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l) { i++; continue; }                       // blank: block separator
    const closer = l.startsWith("/*") ? /\*\//
      : l.startsWith("<!--") ? /-->/
      : null;
    if (closer) {
      const from = i;
      let j = i;
      if (!closer.test(lines[j])) {                  // closer on a later line
        j++;
        while (j < lines.length && !closer.test(lines[j])) j++;
        if (j >= lines.length) j = lines.length - 1; // unterminated: be conservative
      }
      blocks.push({ from, to: j });
      regionEnd = j;
      i = j + 1;
      continue;
    }
    if (isLineComment(lines[i])) {                   // a run of `//` / `rem` / `#`
      const from = i;
      while (i < lines.length && lines[i].trim() && isLineComment(lines[i])) i++;
      blocks.push({ from, to: i - 1 });
      regionEnd = i - 1;
      continue;
    }
    break;                                           // real code ends the region
  }
  if (!blocks.length) return { out: text, changed: false };

  const kept: string[] = [];
  for (const b of blocks) {
    const body = lines.slice(b.from, b.to + 1);
    if (body.some(isAttribution)) continue;          // the whole block goes
    kept.push(...body);
  }
  const out = [...lines.slice(0, start), ...kept, ...lines.slice(regionEnd + 1)].join("\n");
  return { out, changed: out !== text };
}

/**
 * Remove the online-update feature from the panel.
 *
 * This copy is not published anywhere, so the update checker has nothing to
 * check: it would poll a repository that does not exist and, worse, offer a
 * "Download & update" button that replaces the engine with someone else's
 * build. Removing the UI without its JS would leave handlers bound to missing
 * elements, and removing the JS without the markup would leave dead controls —
 * so all four layers go together:
 *
 *   1. the Settings markup (three `.set-row` blocks),
 *   2. the JS that renders and drives them,
 *   3. the i18n keys (leaving them is harmless but misleading),
 *   4. the on-load call that reads the last background result.
 *
 * The SERVER-side endpoints and scheduler are removed separately (see
 * STRIPPED_FILES and the index.ts substitution), because a hidden button does
 * not stop a background timer from phoning home.
 */
function stripUpdateFeature(text: string): { out: string; changed: boolean } {
  const before = text;
  let out = text;

  // 1. Markup: the check row, the progress row and the action row, as a unit.
  out = out.replace(
    /\n[ \t]*<div class="set-row" style="border-top:1px solid var\(--line\);padding-top:14px;margin-top:6px">\n[ \t]*<div>\n[ \t]*<div class="lbl" data-i18n="set_update">[\s\S]*?id="upd-restart"[^\n]*\n[ \t]*<\/div>\n[ \t]*<\/div>\n/g,
    "\n",
  );

  // 2. JS: renderUpdateCheck + the three click handlers + the poller.
  out = out.replace(
    /\/\*\*\n \* Render an update-check result into the Settings row\.[\s\S]*?\n\}\n(?=document\.getElementById\("set-copy-key"\))/,
    "",
  );
  out = out.replace(
    /^let updState = null;\n/gm,
    "",
  );
  out = out.replace(
    /^function updRender\(j\) \{[\s\S]*?\n\}\nasync function updPoll\(\) \{[\s\S]*?\n\}\n/gm,
    "",
  );
  out = out.replace(
    /^document\.getElementById\("upd-check"\)\.onclick = async \(\) => \{[\s\S]*?\n\};\n/gm,
    "",
  );
  out = out.replace(
    /^document\.getElementById\("upd-apply"\)\.onclick = async \(\) => \{[\s\S]*?\n\};\n/gm,
    "",
  );
  out = out.replace(
    /^document\.getElementById\("upd-restart"\)\.onclick = async \(\) => \{[\s\S]*?\n\};\n/gm,
    "",
  );

  // 3. The on-load reads: the version label and the last-check result.
  out = out.replace(
    /^[ \t]*\/\/ Current build version for the update row[\s\S]*?\n[ \t]*\} catch \{\}\n(?=[ \t]*\/\/ Surface the result)/m,
    "",
  );
  out = out.replace(
    /^[ \t]*\/\/ Surface the result of the LAST BACKGROUND check[\s\S]*?\n[ \t]*\} catch \{\}\n/m,
    "",
  );

  // 4. i18n keys. `upd_*` never appears in surviving markup, so every one goes.
  out = out.replace(/^[ \t]*upd_[a-z_]+:[^\n]*\n/gm, "");
  out = out.replace(/\bupd_[a-z_]+:[^\n]*?(?=\n)/g, (m) => (m.includes("set_update") ? m : ""));
  // Keys that share a line with survivors are removed in place.
  for (const key of ["set_update", "set_update_cur", "set_update_idle"]) {
    out = out.replace(new RegExp(`\\b${key}:\\s*"[^"]*",\\s*`, "g"), "");
    out = out.replace(new RegExp(`\\b${key}:\\s*"[^"]*"`, "g"), "");
  }

  // 5. The CSS the progress bar used (only the update row referenced it).
  out = out.replace(/^[ \t]*\.upd-bar \{[\s\S]*?\n[ \t]*\}\n/gm, "");
  out = out.replace(/^[ \t]*\.upd-fill[^\n]*\n/gm, "");
  out = out.replace(/^[ \t]*@keyframes upd-slide[^\n]*\n/gm, "");

  // 6. The section banner the handlers lived under. Without this a stray
  //    "Online update" heading is left floating above unrelated code, which
  //    reads as though the feature is still there.
  out = out.replace(/^[ \t]*\/\/ ── Online update ─+[^\n]*\n/gm, "");

  return { out, changed: out !== before };
}

/**
 * Remove the donate feature as a whole: its launcher link, its modal, its
 * script, its i18n keys, and the route that serves the QR.
 *
 * Line-deletion alone is not enough here — the modal is a multi-line div, the
 * script is a multi-line statement, and the i18n keys share lines with keys
 * that must survive. Each is therefore cut as a unit. Leaving the route in
 * place would keep a public endpoint that serves the donation image, and
 * leaving the i18n keys would break the panel-integrity test, which asserts
 * every `data-i18n` key resolves in BOTH dictionaries.
 */
function stripDonateFeature(text: string): { out: string; changed: boolean } {
  const before = text;
  let out = text;

  // 1. The modal: from its opening div to its matching close, inclusive.
  out = out.replace(/\n[ \t]*<div class="mask" id="donate-mask">[\s\S]*?\n[ \t]*<\/div>\n/g, "\n");

  // 2. The launcher link inside .foot-row.
  out = out.replace(/^[ \t]*<a href="#" id="donateLink"[^\n]*\n/gm, "");

  // 3. The script that opens/closes the modal and fetches the QR.
  out = out.replace(    /^[ \t]*document\.getElementById\("donateLink"\)\.onclick[\s\S]*?\.catch\(\(\) => \{[^\n]*\}\);\n/gm,
    "",
  );

  // 4. i18n keys. These share lines with keys that stay, so the key is removed
  //    by pattern rather than by line. The trailing comma of the removed pair is
  //    kept implicit: the regex consumes `key: "...", ` including its separator.
  for (const key of ["donate_title", "donate_sub", "donate", "author", "free_notice"]) {
    out = out.replace(new RegExp(`\\b${key}:\\s*"[^"]*",\\s*`, "g"), "");
    out = out.replace(new RegExp(`\\b${key}:\\s*"[^"]*"`, "g"), "");
  }

  // 5. The CSS rule for the QR image.
  out = out.replace(/^[ \t]*\.donate-img \{[^\n]*\n/gm, "");

  // 6. The public route that serves the donation QR, and its comment. The
  //    `for` loop inside contains braces at two depths, so the body is matched
  //    up to the route's OWN closing brace — a lazy `*?` would stop at the inner
  //    one and leave the tail (`return new Response("not found"...)`) behind as
  //    orphaned code that does not parse.
  out = out.replace(
    /^[ \t]*\/\/ Public asset routes[^\n]*\n[ \t]*if \(req\.method === "GET" && path === "\/donate\.png"\) \{[\s\S]*?\n[ \t]*\}\n[ \t]*return new Response\("not found", \{ status: 404 \}\);\n[ \t]*\}\n/gm,
    "",
  );

  return { out, changed: out !== before };
}

/** Strip the panel's visible footer attribution and its i18n labels. */
function stripPanelFooter(text: string): { out: string; changed: boolean } {
  const before = text;
  let out = text;

  // The sidebar footer is REPLACED rather than edited. It holds the 交流群,
  // the author link, the 52pojie link, the copyright line and the "free of
  // charge" notice — plus the language button, which must survive. Rewriting the
  // whole element keeps the markup balanced and the switcher working; removing
  // the rows line by line would strand their wrappers and could take the button
  // with them.
  const footRe = /([ \t]*)<div class="side-foot">[\s\S]*?\n\1<\/div>/;
  const m = footRe.exec(out);
  if (m) {
    const indent = m[1];
    const replacement = [
      `${indent}<div class="side-foot">`,
      `${indent}  <div class="foot-row">`,
      `${indent}    <button class="badge-lang" id="langBtn">EN</button>`,
      `${indent}  </div>`,
      `${indent}</div>`,
    ].join("\n");
    out = out.replace(footRe, replacement);
  }

  // Whole-line removals for anything the footer replacement did not cover.
  const drop = [
    /^[^\n]*qq\.com[^\n]*$/gim,
    /^[^\n]*github\.com\/YU123-ZZZ[^\n]*$/gim,
    /^[^\n]*52pojie[^\n]*$/gim,
    /^[^\n]*1091692024[^\n]*$/gim,
    /^[^\n]*YU123-ZZZ[^\n]*$/gim,
    /^[^\n]*收费的一律是骗子[^\n]*$/gim,
    /^[^\n]*收费的都是骗子[^\n]*$/gim,
    /^[^\n]*完全开源免费[^\n]*$/gim,
    /^[^\n]*本项目完全开源[^\n]*$/gim,
    /^[^\n]*二次分发[^\n]*$/gim,
    /^[^\n]*非官方修改版[^\n]*$/gim,
    /^[^\n]*均非本项目官方授权[^\n]*$/gim,
    /^[^\n]*均不代表作者官方作品[^\n]*$/gim,
    /^[^\n]*官方收费版本[^\n]*$/gim,
    /^[^\n]*未经作者允许[^\n]*$/gim,
    /^[^\n]*AI 助手的内置提示词[^\n]*$/gim,
    /^[^\n]*commercial resale[^\n]*$/gim,
    /^[^\n]*Preserve this notice[^\n]*$/gim,
    /^[^\n]*黑骑士网关[^\n]*$/gim,
    /^[^\n]*Black Knight Gateway[^\n]*$/gim,
    /^[^\n]*free_notice[^\n]*$/gim,
    /^[^\n]*data-i18n="author"[^\n]*$/gim,
    /^[^\n]*©\s*2026[^\n]*$/gim,
    /^[^\n]*交流群[^\n]*$/gim,
    /^[^\n]*打赏[^\n]*$/gim,
  ];
  for (const re of drop) out = out.replace(re, "");
  return { out, changed: out !== before };
}

/**
 * Remove the brand mark from the panel and drop its runtime dependency.
 *
 * The clean copy ships without `logo.svg` (and without `icons/`), so every
 * surface that referenced it would render a broken image: the tab favicon, the
 * sidebar lockup, the login crest and the empty-state illustration. Deleting the
 * file alone would have produced exactly that, so the markup is rewritten to the
 * text-only branding rather than left to 404.
 *
 * Each site is replaced rather than deleted, because the surrounding element
 * carries real content — the sidebar row still needs its product name and
 * tagline, and the login brand is the dialog's heading. Only the <img> and the
 * now-dead CSS rules go.
 *
 * The route that served the file stays (see routes-admin.ts): it is harmless
 * when the file is absent, and keeping it means the SOURCE tree keeps working
 * unchanged. That is also why this runs here rather than in the engine.
 */
function stripLogo(text: string): { out: string; changed: boolean } {
  const before = text;
  let out = text;

  // The tab icon. Removing the <link> makes the browser fall back to its
  // default favicon, which is the correct look for a copy with no mark.
  out = out.replace(/^[ \t]*<link rel="icon"[^>]*>\s*$/gim, "");

  // Sidebar lockup. Replaced as a BLOCK, scoped to its own closing tag.
  //
  // Two things are handled together. The <img> is gone, and the tagline shares
  // a line with the product name — the line reads
  // `<div><div class="t1">ZcodeKnight</div><div class="t2" ...>Black Knight
  // Gateway</div></div>`. A later sweep drops any line carrying that brand
  // phrase, which would take the NAME with it and leave the sidebar lockup
  // empty; rewriting the block so the name sits on its own line leaves that
  // sweep nothing to match. This is also why the logo surgery must run before
  // stripPanelFooter (see the call site).
  out = out.replace(
    /([ \t]*)<div class="logo">[\s\S]*?\n\1<\/div>/,
    (m, indent: string) =>
      m.includes("t1")
        ? `${indent}<div class="logo">\n${indent}  <div class="t1">ZcodeKnight</div>\n${indent}</div>`
        : m,
  );

  // Login crest. The wrapper stays: it is what positions the heading.
  out = out.replace(/^[ \t]*<img class="login-crest"[^>]*>\s*$/gim, "");

  // Empty-state illustration, inside a JS string. Replaced with the bare
  // container so the message below it still renders.
  out = out.replace(
    /<img class="big" src="\/admin\/api\/logo\.svg"[^>]*>/g,
    "",
  );

  // CSS that only ever targeted the removed elements. `.logo svg` was already
  // dead (the markup used an <img>), and `.login-crest` sized an image that no
  // longer exists; leaving either would be a rule with no subject.
  out = out.replace(/^[ \t]*\.logo svg \{[^}]*\}\s*$/gim, "");
  out = out.replace(/^[ \t]*\.login-crest \{[^}]*\}\s*$/gim, "");

  return { out, changed: out !== before };
}

/**
 * Tokens that cannot appear in functional code, so any line carrying one is
 * attribution and may be dropped wherever it sits — including outside a comment
 * block, which is where the launchers put their banners (`echo   ZcodeKnight -
 * Black Knight Gateway`). Deliberately narrower than ATTRIBUTION_PATTERNS: this
 * list is applied to every line of every text file, so a token like `author`
 * would delete `headers["authorization"]`.
 */
const SAFE_DROP_TOKENS = [
  "YU123-ZZZ", "52pojie", "1091692024", "sUAFJgC3Fm",
  "收费的一律是骗子", "收费的都是骗子", "本项目完全开源", "二次分发",
  "非官方修改版", "均非本项目官方授权", "均不代表作者官方作品", "官方收费版本",
  "未经作者允许", "黑骑士网关", "Black Knight Gateway",
  "commercial resale", "Preserve this notice", "AI 助手的内置提示词",
];

/** Drop every line carrying a token that cannot be functional code. */
function stripTokenLines(text: string): { out: string; changed: boolean } {
  const before = text;
  const out = text
    .split("\n")
    .filter((l) => !SAFE_DROP_TOKENS.some((t) => l.includes(t)))
    // A banner whose title line was just dropped leaves its underline behind
    // (`echo   ==================`), which would print as a bare rule. Only
    // pure-separator echo lines are matched, so real output is untouched.
    .filter((l) => !/^[ \t]*echo[ \t]+[=\-─]{6,}[ \t]*$/i.test(l))
    .join("\n");
  return { out, changed: out !== before };
}

const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".txt", ".yml", ".yaml", ".bat", ".sh", ".ps1", ".json", ".svg", ".html", ".css"]);

/**
 * Extensionless files that are still text and must be processed.
 *
 * `Dockerfile` matters most: it carries a `COPY docs ./docs` that would fail the
 * build in this copy, where docs/ does not exist.
 */
const TEXT_BASENAMES = new Set(["Dockerfile", "dockerfile", "Makefile", ".dockerignore", ".gitignore"]);

/** True when a file's contents should be run through the strippers. */
function isTextFile(f: string): boolean {
  const base = f.split(/[\\/]/).pop() || "";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
  return TEXT_EXT.has(ext) || TEXT_BASENAMES.has(base);
}

/**
 * Replacements that are NOT just deletions.
 *
 * `DEFAULT_REPO` is functional — the updater queries it for releases. Blanking
 * it would leave the clean copy checking an empty URL forever, so it is pointed
 * at a placeholder the owner can edit, with the reason in a comment.
 *
 * The Dockerfile's `COPY docs ./docs` is the other one: `docs/` holds only the
 * donation QR and is excluded from this copy, so the instruction would fail the
 * build with "docs: not found". It is removed rather than left to fail.
 */
const FUNCTIONAL_SUBS: Array<[RegExp, string]> = [
  [
    /const DEFAULT_REPO = "YU123-ZZZ\/zcodeknight";/g,
    '// Owner/repo the updater checks for releases. Set this to your own fork if\n// you want the online-update button to work; left empty it simply reports no\n// release rather than failing.\nconst DEFAULT_REPO = "";',
  ],
  [
    // Keep this copy independent of the user profile.
    //
    // The engine migrates accounts from ~/.zcode-knight on first start when its
    // own store is absent. That is right for an upgrade but wrong here: this
    // copy is meant to be standalone, so deleting its data/ would silently
    // re-import whatever accounts the profile happens to hold. The launcher sets
    // the opt-out before starting the engine, so the copy never picks them up.
    /^start "ZcodeKnight" %ENGINE% %ENGINE_ARGS% --cli serve >nul 2>&1$/m,
    'rem Independent store: never import accounts from the user profile. Without\n' +
    'rem this, wiping data\\ would silently re-import ~/.zcode-knight on next start.\n' +
    'set "ZCODE_KNIGHT_NO_MIGRATE=1"\n' +
    'start "ZcodeKnight" %ENGINE% %ENGINE_ARGS% --cli serve >nul 2>&1',
  ],
  [
    // The desktop shortcut must not require the brand mark.
    //
    // This copy ships without icons/ (the .ico is the author's artwork), and
    // the source script exits 1 with "ERROR: icon missing" when it is absent —
    // so creating a shortcut would fail outright. Rewritten to make the icon
    // OPTIONAL: the .lnk is still created and verified, it just falls back to
    // the default Windows icon.
    /if \(-not \(Test-Path \$ico\)\) \{ Write-Host "ERROR: icon missing: \$ico"; exit 1 \}/,
    `# No icon in this copy: the mark is not redistributed here. The shortcut is
# still created and verified; it just uses the default Windows icon.
$useIcon = Test-Path $ico`,
  ],
  [
    /^\$s\.IconLocation     = "\$ico,0"$/m,
    'if ($useIcon) { $s.IconLocation = "$ico,0" }',
  ],
  [
    /^\(Get-Item \$ico\)\.LastWriteTime = Get-Date$/m,
    'if ($useIcon) { (Get-Item $ico).LastWriteTime = Get-Date }',
  ],
  [
    /^Write-Host "icon    : \$\(\$check\.IconLocation\)"$/m,
    'Write-Host "icon    : $(if ($useIcon) { $check.IconLocation } else { "(default)" })"',
  ],
  [
    // Disable the periodic release check entirely.
    //
    // Removing the panel's update UI is not enough: index.ts starts a scheduler
    // that polls GitHub every 5 days regardless of whether any button exists.
    // In a copy that is not published this is pure noise — it asks about a
    // repository that will never have a release — and it is an outbound call
    // the operator did not ask for. Replacing the call with a comment keeps the
    // surrounding startup logging intact and makes the removal visible to
    // anyone reading the file.
    /^[ \t]*\/\/ Periodic release check[\s\S]*?\.catch\(\(err\) => console\.error\(`\[update\] scheduler failed to start: \$\{\(err as Error\)\.message\}`\)\);\n/m,
    "  // Online update is not part of this build: the scheduler, the panel UI and\n  // the /update/* endpoints were removed together. See build-clean-copy.ts.\n",
  ],
  [
    // Remove the /update/* endpoints from the admin API.
    //
    // The panel no longer calls them, but leaving them would keep a route that
    // downloads and installs a build from a repository this copy does not
    // track — reachable by anyone with the admin key. Cut as one block, from
    // the leading comment to the closing brace of the last handler.
    /^[ \t]*\/\/ Self-update\. `GET \/update\/check`[\s\S]*?\n[ \t]*return json\(\{ ok: true, restarting: true, script \}\);\n[ \t]*\}\n/m,
    "",
  ],
  [
    /^[ \t]*COPY docs \.\/docs\n/gm,
    "",
  ],
  [
    // The comment block above the COPYs explains both static assets. `docs/` is
    // gone from this copy, so the block is REPLACED whole — removing the docs
    // lines one at a time leaves orphaned fragments ("drop in as login-bg.jpg")
    // and a sentence that ends mid-clause ("Verified by").
    /# Static assets the panel serves at runtime[\s\S]*?# donate\.png all answer 200\.\n/,
    [
      "# Static assets the panel serves at runtime. These are NOT compiled into the",
      "# binary — they are read from disk per request — so a binary-only image answers",
      "# 404 for every one of them:",
      "#   logo.svg   the panel mark, shared by the sidebar, login screen and favicon",
      "#              (one file by design; see routes-admin.ts)",
      "#",
      "# The panel HTML itself (server/src/admin.txt, webui.txt) and the system-prompt",
      '# sidecar (proxy/zcode_system.json) are `import ... with { type: "text"|"json" }`,',
      "# so Bun inlines them at compile time and they are NOT needed here. Verified by",
      "# running the compiled binary with no source tree beside it: /admin and",
      "# logo.svg both answer 200.",
      "",
    ].join("\n"),
  ],
  [
    // The reverse-engineering block names a directory this copy does not ship
    // (see SKIP_DIRS), so the entries and their explanation would describe files
    // that are not here. `*.asar` is kept: it is a general guard, not a note
    // about _reverse.
    /# ── 逆向工程笔记 ─+[\s\S]*?\n\*\.asar\n/,
    "# ── 逆向产物 ───────────────────────────────────────────────────────────────\n*.asar\n",
  ],
];

let stripped = 0;
for (const f of walk(DEST)) {
  if (!isTextFile(f)) continue;
  const original = readFileSync(f, "utf-8");
  let text = stripHeader(original).out;
  // BEFORE the token sweep: DEFAULT_REPO's value contains YU123-ZZZ, so a
  // token-first order would delete the declaration and break the updater.
  for (const [re, to] of FUNCTIONAL_SUBS) text = text.replace(re, to);
  // ALSO BEFORE the token sweep, and for the same class of reason: the i18n
  // dictionaries pack several keys onto one line, so a line containing the scam
  // notice also carries an innocent key like `bal_none`. Dropping the line whole
  // would delete that key from one language only, and the panel-integrity test
  // rightly fails on a dictionary that is missing a referenced key. The surgical
  // removals below take out just the attribution keys first, leaving the line
  // with no token for the sweep to find.
  if (f.includes("admin.txt") || f.includes("webui.txt") || f.endsWith("routes-admin.ts")) {
    text = stripDonateFeature(text).out;
  }
  // The online-update feature is removed from the panel AND its scheduler is
  // disabled in index.ts below — a hidden button does not stop a timer.
  if (f.includes("admin.txt")) {
    text = stripUpdateFeature(text).out;
  }
  // The copy ships without the brand mark, so the panel is rewritten to its
  // text-only branding instead of pointing at a file that is not there.
  //
  // MUST run before stripPanelFooter. That sweep drops every line carrying
  // "Black Knight Gateway" — which is the sidebar's tagline line, and that line
  // also carries the `<div class="t1">` opening for the product name. Once it is
  // gone the `.logo` block no longer has balanced markup, the block regex below
  // cannot match, and the <img> survived into the copy as a broken image. Doing
  // the logo surgery first keeps the markup whole.
  if (f.includes("admin.txt")) {
    text = stripLogo(text).out;
  }
  if (f.includes("admin.txt") || f.includes("webui.txt")) {
    text = stripPanelFooter(text).out;
  }
  text = stripTokenLines(text).out;
  if (text !== original) {
    // Restore CRLF for .bat files. cmd.exe requires it: with bare LF it drops
    // the first character of some lines (setlocal becomes tlocal) and
    // mis-terminates if/for blocks, so the launcher fails in ways that look
    // like logic bugs. The split/join in the strippers normalises to LF, so
    // this has to be undone here rather than assumed.
    if (f.toLowerCase().endsWith(".bat")) text = text.replace(/\r?\n/g, "\r\n");
    writeFileSync(f, text, "utf-8");
    stripped++;
  }
}
console.log(`清理版权/联系方式：${stripped} 个文件`);

// ── 4. report ─────────────────────────────────────────────────────────────────
const leftover: string[] = [];
for (const f of walk(DEST)) {
  if (!isTextFile(f)) continue;
  const s = readFileSync(f, "utf-8");
  // The same token list the sweep uses, so a survivor cannot hide behind a
  // spelling the report did not happen to check for.
  for (const m of SAFE_DROP_TOKENS) {
    if (s.includes(m)) { leftover.push(`${relative(DEST, f)}  ← ${m}`); break; }
  }
}
console.log(leftover.length ? `\n仍有残留（${leftover.length}）：\n` + leftover.slice(0, 20).join("\n") : "\n✓ 无残留");
const mdLeft = walk(DEST).filter((f) => f.toLowerCase().endsWith(".md"));
console.log(mdLeft.length ? `✗ 还有 md：${mdLeft.map((f) => relative(DEST, f)).join(", ")}` : "✓ 无 markdown 文件");
if (existsSync(join(DEST, "docs"))) console.log("✗ docs/ 仍在（含打赏码）");
else console.log("✓ 无 docs/（打赏码已排除）");
// Report what must NOT be here, so a silent regression is visible: these carry
// credentials or third-party artifacts, and their absence is the point.
//
// `data/` is deliberately absent from this list: it is the copy's own runtime
// state, preserved across rebuilds (see PRESERVE_IN_DEST), and its presence is
// correct rather than a leak. What must never come across is the SOURCE tree's
// credentials, which is what `config.yaml` covers.
for (const [p, why] of [
  ["config.yaml", "本机 proxy key 与设备指纹"],
  ["_reverse", "逆向笔记 + 313MB 客户端副本"],
  ["server/config.yaml", "本机 proxy key"],
] as Array<[string, string]>) {
  console.log(existsSync(join(DEST, p)) ? `✗ ${p} 仍在（${why}）` : `✓ 无 ${p}（${why}）`);
}

// State that is expected to be here, reported so its survival is visible rather
// than assumed — a rebuild that quietly dropped the account store is exactly the
// failure this replaced.
for (const [p, label] of [["data", "账号库"], ["workspace", "工作目录（引擎不再写入，保留以兼容旧副本）"]] as Array<[string, string]>) {
  const full = join(DEST, p);
  if (!existsSync(full)) { console.log(`· 无 ${p}/（${label}，副本尚未产生）`); continue; }
  const n = statSync(full).isDirectory() ? readdirSync(full).length : 0;
  console.log(`✓ 保留 ${p}/（${label}，${n} 项）`);
}

// ── 5. make the copy runnable ─────────────────────────────────────────────────
//
// The copy is meant to be launched, not just read: double-click ZcodeKnight.bat
// and the panel opens. That needs the engine binary, which the file walk above
// deliberately does not carry (it would be a binary built from OTHER sources).
// So it is built here, from the copy's own sources, with the same flags the
// release build uses.
//
// Skipped when no Bun runtime is available — the copy still works, it just
// needs setup.bat first. Reported either way rather than failing the whole run.
console.log("");
const runtime = join(DEST, "server", "runtime.exe");
const engineOut = join(DEST, "ZcodeKnight.exe");
if (!existsSync(runtime)) {
  // Prefer the source tree's runtime so a copy is immediately runnable without
  // a network fetch; setup.bat remains the fallback for a fresh machine.
  const srcRuntime = join(SRC, "server", "runtime.exe");
  if (existsSync(srcRuntime)) {
    copyFileSync(srcRuntime, runtime);
    console.log("已复制 Bun 运行时（副本可直接构建/运行）");
  }
}
if (existsSync(runtime)) {
  // Dependencies first: the bundle imports `yaml`, `happy-dom` and `undici`, and
  // `bun build` resolves them from node_modules. The copy deliberately does not
  // carry node_modules (platform-specific binaries), so it is installed here.
  // --frozen-lockfile keeps the copy on the same versions as the source tree.
  const inst = Bun.spawnSync([runtime, "install", "--frozen-lockfile"], {
    cwd: join(DEST, "server"), stdout: "pipe", stderr: "pipe",
  });
  if (inst.exitCode !== 0) {
    console.log(`✗ 依赖安装失败：${inst.stderr.toString().trim().slice(0, 160)}`);
  }
  // Build to a temp name, then swap it in. Writing straight to the target fails
  // while the copy's engine is running (it holds its own image open), and that
  // is the normal case — the operator is usually running the copy they are
  // rebuilding. Windows forbids deleting a running image but ALLOWS renaming it,
  // so the swap below succeeds and the new binary is in place for the next
  // launch; the running process keeps serving from the renamed file until then.
  //
  // The temp name must END in `.exe`: `bun build` appends `.exe` to any outfile
  // that does not already have it, so `ZcodeKnight.exe.new` silently became
  // `ZcodeKnight.exe.new.exe` and the swap below found nothing to move.
  const tmpOut = join(DEST, "ZcodeKnight-new.exe");
  try { rmSync(tmpOut, { force: true }); } catch { /* left over from a failed run */ }
  const built = Bun.spawnSync(
    [runtime, "build", "--compile", "--define", "require.resolve=undefined",
     "--windows-hide-console", "src/index.ts", "--outfile", "../ZcodeKnight-new.exe"],
    { cwd: join(DEST, "server"), stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode === 0 && existsSync(tmpOut)) {
    // Clear whatever occupies the target path. A locked image (the running
    // engine, or an `.old` left by a previous rebuild) is renamed aside; a
    // stale `.old` that is itself locked is simply left for the next run.
    //
    // `locked` is the real signal for "an engine is running from this file".
    // Testing for the mere PRESENCE of a `ZcodeKnight.exe.*` file was wrong: a
    // rollback copy in the source tree got copied into the destination by the
    // walk (see the engine-binary rule in shouldSkip), and that leftover then
    // announced "the copy is running" on a machine with nothing running at all.
    let locked = false;
    for (const p of [engineOut, `${engineOut}.old`]) {
      if (!existsSync(p)) continue;
      try { rmSync(p, { force: true }); } catch {
        locked = true;
        try { renameSync(p, `${p}.${Date.now()}`); } catch { /* still locked */ }
      }
    }
    let swapped = true;
    try { renameSync(tmpOut, engineOut); } catch { swapped = false; }
    if (swapped) {
      console.log(`✓ 已构建引擎：ZcodeKnight.exe（${(statSync(engineOut).size / 1048576).toFixed(0)} MB，无控制台窗口）`);
      if (locked) {
        console.log("  副本正在运行：新引擎已就位，重启 ZcodeKnight.exe 后生效（旧二进制已改名，下次构建自动清理）");
      }
    } else {
      console.log(`! 引擎已构建为 ZcodeKnight-new.exe，但无法就位（目标被占用且重命名被拒）`);
      console.log("  关掉副本里的 ZcodeKnight.exe 后再跑一次本脚本即可。");
    }
  } else {
    console.log(`✗ 引擎构建失败：${built.stderr.toString().trim().slice(0, 200)}`);
    console.log("  副本仍可用，但首次启动前需要先跑 setup.bat");
  }
} else {
  console.log("! 无 Bun 运行时：副本首次启动前需先跑 setup.bat");
}

// ── 6. make the Docker folder self-contained ─────────────────────────────────
//
// docker/ must be copyable on its own, so the image inputs (src/, lockfile,
// logo.svg) are generated into it rather than referenced from the parent.
//
// Driven from the SOURCE tree's script, not the copy's: prepare-docker.ts is in
// SKIP_FILES (it is build tooling, not part of the shipped product), so looking
// for it under DEST never found anything and this step silently did nothing.
// It reads the copy's own files — ZCODE_KNIGHT_ROOT points it at DEST — so the
// generated docker/ still describes the copy rather than this tree.
const prep = join(SRC, "server", "scripts", "prepare-docker.ts");
if (existsSync(runtime) && existsSync(prep)) {
  const r = Bun.spawnSync([runtime, "run", prep], {
    cwd: DEST,
    env: { ...process.env, ZCODE_KNIGHT_ROOT: DEST },
    stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  console.log(r.exitCode === 0 ? `✓ docker/ 已自包含（${out}）` : `✗ docker/ 准备失败：${r.stderr.toString().trim().slice(0, 160)}`);
}
