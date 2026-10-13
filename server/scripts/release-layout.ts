import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type ReleaseKind = "linux-x64" | "linux-arm64" | "source" | "docker";
export interface ReleaseInput { from: string; to: string }

/**
 * Source package = the complete Windows program PLUS the source tree
 * ("解压双击即用"), matching the release layout the project has always shipped:
 * four assets only — source, docker, and the two bare Linux binaries.
 *
 * Excluded on purpose: docker/ (it has its own package), the Linux binaries
 * (they ship as bare assets), server/runtime.exe (downloaded by setup.bat),
 * node_modules, and live state. The author's own notes (使用说明/策划方案/
 * 维护指南) are not tracked by git and therefore never reach a package.
 */
const ROOT_SOURCE_FILES = new Set([
  "LICENSE", "README.md", ".gitattributes", ".gitignore", "logo.svg",
  "ZcodeKnight.bat", "stop.bat", "setup.bat", "setup.sh", "make-shortcut.ps1",
  "push-to-github.bat",
]);
const SERVER_SOURCE_FILES = new Set([
  "server/package.json", "server/bun.lock", "server/bunfig.toml",
  "server/test-preload.ts", "server/build-clean-copy.ts",
]);
const DOCKER_FILES = new Set([
  "package.json", "bun.lock", "bunfig.toml", "test-preload.ts",
  "Dockerfile", "docker-compose.yml", ".dockerignore", "logo.svg",
]);
const COMMON_RUNTIME_FILES = ["LICENSE", "logo.svg", "docs/zk-support-qr.png"];

export function normalizeReleasePath(value: string): string {
  const path = value.split(String.fromCharCode(92)).join("/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe release path: ${value}`);
  }
  return path;
}

function isRuntimeState(path: string): boolean {
  return /(^|\/)(node_modules|data|analysis|\.git|backups|trash|browser-profile|browser-profiles)(\/|$)/i.test(path)
    || /(^|\/)(config(?:\.local)?\.ya?ml|accounts\.json|credentials\.json|invites\.json|request-stats\.json|admin-log\.jsonl)$/i.test(path)
    || /\.(log|bak|tmp|7z|zip|tar|gz)$/i.test(path);
}

export function isSourceInput(path: string): boolean {
  if (isRuntimeState(path) || /(^|\/)(runtime(?:\.exe)?|ZcodeKnight(?:\.dat|\.exe)?|ZcodeKnight-YU-[^/]+)$/i.test(path)) return false;
  if (ROOT_SOURCE_FILES.has(path) || SERVER_SOURCE_FILES.has(path)) return true;
  if (path.startsWith("server/src/")) return /\.(ts|txt|json)$/.test(path);
  if (path.startsWith("server/scripts/")) return /\.(ts|mjs|md|sh)$/.test(path);
  return /^(docs|icons)\//.test(path) && /\.(png|svg|ico|md)$/.test(path);
}

/** Platform plans are allowlists; the source tree is never recursively packed. */
export function releaseInputs(kind: ReleaseKind, candidates: string[]): ReleaseInput[] {
  const all = [...new Set(candidates.map(normalizeReleasePath))].sort();
  // SOURCE = complete Windows program + source. The .dat binary is produced by
  // the build (it is not a tracked file), so it is added by the packer rather
  // than coming from this list.
  if (kind === "source") return all.filter(isSourceInput).map((path) => ({ from: path, to: path }));
  if (kind === "docker") return all.filter((path) => {
    if (!path.startsWith("docker/") || isRuntimeState(path)) return false;
    const rel = path.slice(7);
    return DOCKER_FILES.has(rel) || /^src\/.*\.(ts|txt|json)$/.test(rel)
      || /^docs\/.*\.(png|svg)$/.test(rel);
  }).map((path) => ({ from: path, to: path }));
  // Bare Linux binaries: the executable is added by the packer; only the small
  // shared runtime bits come from the tree.
  const allowed = new Set(COMMON_RUNTIME_FILES);
  return all.filter((path) => allowed.has(path)).map((path) => ({ from: path, to: path }));
}

export function assertReleaseLayout(kind: ReleaseKind, filenames: string[]): void {
  const files = filenames.map(normalizeReleasePath);
  const required = kind === "source"
    ? ["LICENSE", "README.md", "config.example.yaml", "ZcodeKnight.dat", "ZcodeKnight.bat", "stop.bat",
       "server/src/index.ts", "server/package.json", "server/bun.lock", "server/scripts/package-release.ts"]
    : kind === "docker"
      ? ["docker/README.md", "docker/Dockerfile", "docker/docker-compose.yml", "docker/package.json", "docker/bun.lock", "docker/src/index.ts"]
      : ["LICENSE", "README.md", "config.example.yaml", "ZcodeKnight", "start.sh"];
  for (const path of required) if (!files.includes(path)) throw new Error(`${kind}: missing ${path}`);
  for (const path of files) {
    if (isRuntimeState(path)) throw new Error(`${kind}: runtime state or nested archive: ${path}`);
    if (path === "MANIFEST.json" || path === "config.example.yaml" || path === "ZcodeKnight.dat") continue;
    if (kind === "source") {
      // The Windows binary rides along; nothing else outside the source plan.
      if (!isSourceInput(path)) throw new Error(`source: unexpected input ${path}`);
    } else if (kind === "docker") {
      const rel = path.startsWith("docker/") ? path.slice(7) : "";
      if (!(rel === "README.md" || DOCKER_FILES.has(rel)
        || /^src\/.*\.(ts|txt|json)$/.test(rel) || /^docs\/.*\.(png|svg)$/.test(rel))) {
        throw new Error(`docker: unexpected input ${path}`);
      }
    } else {
      const runtime = new Set([...COMMON_RUNTIME_FILES, "README.md", "ZcodeKnight", "start.sh"]);
      if (!runtime.has(path)) throw new Error(`${kind}: foreign platform/source payload ${path}`);
    }
  }
}

export function inspectBinary(bytes: Buffer): { format: string; arch: string } {
  if (bytes.length < 64) throw new Error("Truncated binary");
  if (bytes[0] === 0x7f && bytes.subarray(1, 4).toString("ascii") === "ELF") {
    if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error("Expected a 64-bit little-endian ELF");
    const machine = bytes.readUInt16LE(18);
    return { format: "ELF", arch: machine === 62 ? "x64" : machine === 183 ? "arm64" : `machine-${machine}` };
  }
  if (bytes.subarray(0, 2).toString("ascii") === "MZ") {
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString("ascii") !== "PE\0\0") throw new Error("Invalid PE header");
    const machine = bytes.readUInt16LE(offset + 4);
    return { format: "PE", arch: machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : `machine-${machine}` };
  }
  throw new Error("Unrecognized binary format");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
