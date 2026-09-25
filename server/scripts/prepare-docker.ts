/**
 * Populate docker/ so that folder is a complete, portable deployment.
 *
 * The Dockerfile builds from the engine's TypeScript sources, so a Docker build
 * needs `server/src`, the lockfile and `logo.svg`. Leaving those in the project
 * root meant the build context had to be the root — which made docker/ a folder
 * you could not copy on its own.
 *
 * This copies exactly what the image needs INTO docker/, so `docker compose up`
 * works after copying that one folder to any machine with Docker. Everything the
 * container writes (data/, config/) also lives there, so the folder
 * is the whole deployment: build inputs, build definition, and runtime state.
 *
 * Run after changing engine sources:
 *   <runtime> run server/scripts/prepare-docker.ts
 *
 * docker/src and friends are GENERATED — never edit them in place, the next run
 * overwrites them.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Project root, from this file's location: `<root>/server/scripts/`.
 *
 * `ZCODE_KNIGHT_ROOT` overrides it so the clean-copy build can point this at
 * the copy while running this file from the source tree. Without the override
 * the generated docker/ would describe whichever tree the script lives in
 * rather than the one being built.
 */
const ROOT = (process.env.ZCODE_KNIGHT_ROOT?.trim()
  || decodeURIComponent(new URL("../../", import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, "$1"))
  .replace(/[/\\]$/, "");
const DEST = join(ROOT, "docker");

/**
 * The brand mark, present in the published tree and absent from the clean copy
 * (which ships without the author's artwork, and whose panel is rewritten to
 * text-only branding). The Dockerfile's COPY and the panel's asset route are
 * both conditional on this, so one script serves both trees.
 */
const HAS_LOGO = existsSync(join(ROOT, "logo.svg"));

/** Files the image needs, as [source relative to ROOT, dest relative to DEST]. */
const FILES: Array<[string, string]> = [
  ["server/package.json", "package.json"],
  ["server/bun.lock", "bun.lock"],
  ["server/bunfig.toml", "bunfig.toml"],
  // bunfig.toml preloads this before any suite runs, to redirect the state
  // directory so no test can read or write a real account pool. Copying the
  // config without the file it names left `bun test` inside docker/ failing with
  // "preload not found" — and it silently dropped that safety net rather than
  // failing loudly in the image build (which never runs tests).
  ["server/test-preload.ts", "test-preload.ts"],
  // The manual. docker/ is handed to people as a folder — copied to a Docker
  // host, or packed and mailed — so it has to describe itself; whoever receives
  // it has no README beside it. Listed here rather than copied in by hand
  // because this script is what produces docker/, and a file placed there
  // manually is not regenerated: delete docker/ and the manual is gone.
  //
  // The clean copy has no .md at all (SKIP_EXT drops them), so this is
  // conditional — the same script serves both trees.
  ...(existsSync(join(ROOT, "README.md")) ? [["README.md", "README.md"] as [string, string]] : []),
  ...(HAS_LOGO ? [["logo.svg", "logo.svg"] as [string, string]] : []),
];
/** Directories copied whole. */
const DIRS: Array<[string, string]> = [
  ["server/src", "src"],
];

/**
 * `docs/` holds the donate QR and is only in the published tree. The clean copy
 * has no docs/ and its Dockerfile has no COPY for it, so this is conditional —
 * the same script serves both trees.
 */
const HAS_DOCS = existsSync(join(ROOT, "docs"));

/**
 * Files never copied into the build context, whatever directory they sit in.
 *
 * A `config.yaml` is a live config: it holds the operator's proxy key and
 * device identity, and it can appear anywhere the engine was ever launched with
 * a relative config path (the fallback is `config.yaml` against the cwd, so a
 * run from `server/` leaves one in `server/`, and a run from a copied tree
 * leaves one inside its `src/`). Copying it would bake one deployment's
 * credentials into the image AND make the image ignore the config compose
 * mounts over /app/config — the engine would read the baked-in file instead.
 */
const NEVER_COPY = new Set(["config.yaml", "config.yml", "config.local.yaml"]);

/** Replace a directory's contents, tolerating Windows handle lag. */
function syncDir(src: string, dest: string): number {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const e of readdirSync(src)) {
    if (NEVER_COPY.has(e)) continue;
    const s = join(src, e), d = join(dest, e);
    if (statSync(s).isDirectory()) {
      n += syncDir(s, d);
    } else {
      copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

let copied = 0;
for (const [s, d] of FILES) {
  const src = join(ROOT, s);
  if (!existsSync(src)) { console.log(`  skip (missing): ${s}`); continue; }
  copyFileSync(src, join(DEST, d));
  copied++;
}
for (const [s, d] of DIRS) {
  const src = join(ROOT, s);
  if (!existsSync(src)) { console.log(`  skip (missing): ${s}`); continue; }
  copied += syncDir(src, join(DEST, d));
}
if (HAS_DOCS) {
  copied += syncDir(join(ROOT, "docs"), join(DEST, "docs"));
}

console.log(`  docs/: ${HAS_DOCS ? "included (source tree)" : "absent (clean copy)"}`);

// Verify nothing credential-bearing reached the context. Two separate checks,
// because the failure mode is silent: a stray config would be baked into the
// image and the container would then ignore the config compose mounts, while
// every log line still said the build succeeded.
//
//   1. Scan DEST — catches a path that bypassed NEVER_COPY.
//   2. Scan the SOURCE tree — catches the more likely case, where a stray was
//      simply never copied (so DEST looks clean) and nobody learns the tree has
//      one. That stray is also a live config the engine may later read.
const CONFIG_RE = /^config\.(ya?ml|local\.ya?ml)$/i;
function findConfigs(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { findConfigs(p, out); continue; }
    if (CONFIG_RE.test(e)) out.push(p);
  }
}
const inDest: string[] = [];
findConfigs(DEST, inDest);
const inSrc: string[] = [];
for (const d of ["server/src", "server/scripts", "docker"]) {
  const p = join(ROOT, d);
  if (existsSync(p)) findConfigs(p, inSrc);
}
if (inDest.length) {
  console.log(`  ✗ 危险：配置进了构建上下文（含 proxy key / 设备指纹）：${inDest.map((p) => relative(ROOT, p)).join(", ")}`);
  process.exitCode = 1;
} else if (inSrc.length) {
  // Not fatal — they are excluded from the copy — but the tree should not have
  // them, so name them rather than letting them accumulate.
  console.log(`  ! 源码树里有游离 config（已排除，未进镜像）：${inSrc.map((p) => relative(ROOT, p)).join(", ")}`);
} else {
  console.log("  ✓ 无 config 文件（不会把本机凭证打进镜像）");
}

console.log("  now portable: copy this folder anywhere with Docker and run");
console.log("    docker compose up -d");

/**
 * The Dockerfile for the self-contained context.
 *
 * Identical build steps to the root-level original, with COPY paths rewritten
 * for a context rooted at docker/. Kept as one literal here so the two can be
 * compared by reading, and so the generated file can never drift from what this
 * script intends.
 */
const DOCKERFILE = `# ZcodeKnight — container image.
#
# Two stages so the runtime image carries no build tooling:
#   1. compile the engine into one self-contained binary
#   2. copy just that binary into a slim base
#
# Everything this file needs is IN THIS FOLDER (src/, package.json, bun.lock,
# logo.svg), so the build context is docker/ itself and the folder can be copied
# to any machine with Docker and built there.
#
# The compile runs on \`oven/bun\`, whose architecture matches the image's, so it
# is a NATIVE build rather than a cross-build. That matters: \`bun build
# --compile --target bun-linux-x64\` requires Bun to download the Linux runtime,
# which fails on a restricted network — and produces a binary for an
# architecture the build host may not be. Letting BuildKit select the base
# image per platform is both simpler and more reliable.
FROM oven/bun:1.4.2 AS build
WORKDIR /src

# \`bun.lock\` is copied too: without it \`bun install\` resolves fresh versions and
# the image can silently differ from a local build. \`bunfig.toml\` carries the
# registry mirror setting.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --production

COPY src ./src
RUN bun build --compile --define "require.resolve=undefined" src/index.ts --outfile /out/zcodeknight

FROM debian:bookworm-slim
# \`ca-certificates\` is required: every upstream call is HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/zcodeknight ./ZcodeKnight

# Static assets the panel serves at runtime. These are NOT compiled into the
# binary — they are read from disk per request — so a binary-only image answers
# 404 for every one of them:
#   logo.svg   the panel mark, shared by the sidebar, login screen and favicon
#              (one file by design; see routes-admin.ts). Present only in the
#              published tree; the clean copy has no mark and its panel is
#              rewritten to text-only branding, so this COPY is conditional.
# The panel HTML itself (src/server/admin.txt, webui.txt) and the system-prompt
# sidecar (src/proxy/zcode_system.json) are \`import ... with { type: "text"|"json" }\`,
# so Bun inlines them at compile time and they are NOT needed here.
@@LOGO_COPY@@
@@DOCS_COPY@@
# No config.yaml is baked in. Two reasons:
#   1. \`.dockerignore\` excludes it (it holds the proxy key and device identity),
#      so a \`COPY config.yaml\` would fail the build outright.
#   2. The engine writes a template config on first run when the path is
#      missing, which is exactly the behaviour a fresh container wants.
# The compose file mounts the operator's config over this path.
RUN mkdir -p /app/data

# Bind all interfaces inside the container: the engine defaults to 127.0.0.1,
# and a loopback-only bind makes the published port unreachable. Compose sets
# ZCODE_PROXY_HOST=0.0.0.0 for exactly this reason.
#
# The config path is a directory mount point in compose (see docker-compose.yml):
# mounting a single file that does not exist yet makes Docker create a directory
# in its place, which the engine then cannot read. A directory always works and
# the engine writes its template config into it on first run.
ENV ZCODE_PROXY_CONFIG=/app/config/config.yaml
EXPOSE 17800

# Liveness probe against the panel API.
#
# \`admin\` is accepted by the engine as a built-in fallback key even when
# config.yaml sets a real proxyApiKey (see panel-session.ts:checkAdminKey), so
# this passes on a fresh container AND on a configured one without the operator
# having to tell the healthcheck their key. That is deliberate: the probe's job
# is "is the engine answering", not "is the key right" — a wrong key must not
# make an otherwise healthy container restart-loop.
#
# ZCODE_HEALTH_KEY overrides it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS -o /dev/null -H "Authorization: Bearer \${ZCODE_HEALTH_KEY:-admin}" http://127.0.0.1:17800/admin/api/overview || exit 1

ENTRYPOINT ["/app/ZcodeKnight", "--cli", "serve"]
`;

/**
 * Build-context exclusions.
 *
 * The runtime directories are the important part: they hold the encrypted
 * account store and the relay credentials, and a context that included them
 * would bake one deployment's secrets into the next image.
 */
const DOCKERIGNORE = `# Runtime state — never part of an image.
data/
config/
# Kept as a guard, not because the engine uses it: workspace/ was the remote
# control sandbox, and that feature is gone. A hand-made directory of that name
# would otherwise be baked into the image.
workspace/

# Generated build inputs are wanted; build output and caches are not.
node_modules/
dist/
build/

# Anything a previous run left behind.
*.log
*.bak
__pycache__/
*.pyc
`;

// ── the self-contained Dockerfile ───────────────────────────────────────────
//
// Written here rather than copied, because its COPY paths are relative to
// docker/ (the context) and the root-level original uses root-relative paths.
// Keeping one source of truth for the build steps matters more than reusing the
// file verbatim: a Dockerfile that silently diverges is worse than a generated
// one.
//
// The donate QR is a conditional COPY. The route resolves it from `docs/`
// relative to the working directory (routes-admin.ts:/donate.png), so without
// the COPY a containerised SOURCE-tree build answers 404 for the panel's
// support image. It is conditional rather than always-on because the clean copy
// has no docs/ at all, and a `COPY docs/` there fails the build outright.
const docsCopy = HAS_DOCS
  ? `
# The donate/support QR the panel serves at /donate.png. Present only in the
# published (source) tree; the clean copy has no docs/ and omits this line.
COPY docs ./docs
`
  : "";

// Same treatment for the brand mark: a `COPY logo.svg` in a tree that has no
// logo.svg fails the build, and the clean copy deliberately ships without it.
const logoCopy = HAS_LOGO ? "COPY logo.svg ./logo.svg" : "";
writeFileSync(
  join(DEST, "Dockerfile"),
  DOCKERFILE.replace("@@DOCS_COPY@@", docsCopy).replace("@@LOGO_COPY@@", logoCopy),
  "utf-8",
);

// ── .dockerignore for this context ──────────────────────────────────────────
//
// Runtime state must never enter the build context: it holds the encrypted
// account store, and baking it into an image would ship one deployment's
// credentials to the next.
writeFileSync(join(DEST, ".dockerignore"), DOCKERIGNORE, "utf-8");

console.log(`\ndocker/ prepared: ${copied} files`);