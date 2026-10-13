import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EXAMPLE_CONFIG_YAML } from "../src/config/template.ts";
import { assertReleaseLayout, inspectBinary, releaseInputs, sha256File, type ReleaseKind } from "./release-layout.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "server/package.json"), "utf8")).version as string;
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const arg = (key: string) => { const at = args.indexOf(key); return at >= 0 ? args[at + 1] : undefined; };
const output = resolve(arg("--output") || join(root, "dist/releases", `v${version}`, `run-${Date.now()}-${randomUUID().slice(0, 8)}`));
if (existsSync(output)) throw new Error(`Output already exists; use a fresh directory: ${output}`);
const sevenZip = process.env.ZCODE_7ZIP || (process.platform === "win32" ? "C:/Program Files/7-Zip/7z.exe" : "7z");
mkdirSync(output, { recursive: true });
const binDir = join(output, "bin");
mkdirSync(binDir);

function command(executable: string, argv: string[], cwd = root, inherit = false): string {
  const result = spawnSync(executable, argv, { cwd, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", timeout: 600_000, env: process.env });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${argv[0]} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout || "";
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function filesIn(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesIn(join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error(`Unsupported release entry: ${rel}`);
  }
  return files.sort();
}

const sha = command("git", ["rev-parse", "HEAD"]).trim();
const tracked = command("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
const requiredVersion = `ZcodeKnight-YU ${version}`;
const targets = [
  { kind: "windows-x64" as const, target: "bun-windows-x64", filename: "ZcodeKnight.dat", format: "PE", arch: "x64" },
  { kind: "linux-x64" as const, target: "bun-linux-x64", filename: "ZcodeKnight-YU-linux-x64", format: "ELF", arch: "x64" },
  { kind: "linux-arm64" as const, target: "bun-linux-arm64", filename: "ZcodeKnight-YU-linux-arm64", format: "ELF", arch: "arm64" },
];
const built = new Map<ReleaseKind, string>();
const binaryChecks: Array<Record<string, unknown>> = [];
for (const target of targets) {
  const outfile = join(binDir, target.kind === "windows-x64" ? "ZcodeKnight-build.exe" : target.filename);
  if (noBuild) {
    const local = target.kind === "windows-x64" ? join(root, "ZcodeKnight.dat") : join(root, "server", target.filename);
    copy(local, outfile);
  } else {
    const buildArgs = ["build", "--compile", "--target", target.target, "--define", "require.resolve=undefined", "src/index.ts", "--outfile", outfile];
    if (target.kind === "windows-x64") buildArgs.push("--windows-icon", join(root, "icons/ZcodeKnight.ico"));
    console.log(`Building ${target.kind}...`);
    command("bun", buildArgs, join(root, "server"), true);
  }
  const destination = join(binDir, target.filename);
  if (outfile !== destination) renameSync(outfile, destination);
  const check = inspectBinary(readFileSync(destination));
  if (check.format !== target.format || check.arch !== target.arch) throw new Error(`Wrong binary architecture: ${target.filename}`);
  let runtimeValidation: string;
  if (process.platform === "win32" && target.kind === "windows-x64") {
    const actual = command(destination, ["--version"]).trim();
    if (actual !== requiredVersion) throw new Error(`Wrong engine version: ${actual}`);
    runtimeValidation = actual;
  } else {
    const content = readFileSync(destination);
    if (!content.includes(Buffer.from(`export const VERSION = "${version}"`))
      && !content.includes(Buffer.from(`VERSION = "${version}"`))
      && !content.includes(Buffer.from(`VERSION="${version}"`))
      && !content.includes(Buffer.from(`var VERSION = "${version}"`))) {
      throw new Error(`Version ${version} not found in compiled payload: ${target.filename}`);
    }
    runtimeValidation = "cross-compiled; ELF machine and embedded engine version checked; not executed on this Windows host";
  }
  built.set(target.kind, destination);
  binaryChecks.push({ name: target.filename, ...check, version, validation: runtimeValidation, bytes: statSync(destination).size, sha256: sha256File(destination) });
}

const linuxStart = `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
chmod +x "$ROOT/ZcodeKnight"
if [ ! -f "$ROOT/config.yaml" ]; then cp "$ROOT/config.example.yaml" "$ROOT/config.yaml"; fi
exec env CI=1 "$ROOT/ZcodeKnight" --cli serve "$ROOT/config.yaml"
`;

function readme(kind: ReleaseKind): string {
  const head = `# ZcodeKnight v${version} — ${kind}\n\n`;
  if (kind === "windows-x64") return head + "Windows x64 运行包。只含 Windows 引擎、启动/停止脚本和运行资源，不含 Docker、Linux 二进制、源码树或 Bun 运行时。\n\n解压整个目录，双击 `ZcodeKnight.bat`。面板默认为 http://127.0.0.1:17800/admin。首次启动按内置模板生成 `config.yaml`；面板默认密码为 `admin`，客户端 API Key 与面板密码是独立设置。运行数据存于本目录 `data/`。\n\n升级前备份现有配置和 data；覆盖本包程序文件，保留原 config.yaml 与 data。`config.example.yaml` 是从本次源码生成的示例，不含真实凭据。\n\n源码单独下载 `ZcodeKnight-source-v" + version + ".7z`。各文件校验值见 MANIFEST.json。\n";
  return head + "仅适用于 Linux " + (kind === "linux-arm64" ? "aarch64 / arm64" : "x86_64 / amd64") + "。只含本架构引擎和 Linux 启动脚本，不含 Windows、Docker、其他架构二进制或源码树。\n\n```sh\nsh start.sh\n```\n\n前台启动，Ctrl+C 停止。首次复制 config.example.yaml 为 config.yaml；面板默认 http://127.0.0.1:17800/admin，默认面板密码 admin。API Key 与面板密码独立。运行数据位于同目录 data/。\n\n升级前备份现有配置和 data，保留它们，仅替换程序文件。直接下载的裸二进制需 `chmod +x ZcodeKnight-YU-linux-" + (kind === "linux-arm64" ? "arm64" : "x64") + "`，然后使用 `--cli serve` 启动。\n\n本包在 Windows 主机交叉编译；ELF 架构和嵌入版本已校验，未宣称已在本机执行 Linux 引擎。文件校验值见 MANIFEST.json。\n";
}

const assets: string[] = [];
const packageChecks: Array<Record<string, unknown>> = [];
for (const kind of ["windows-x64", "linux-x64", "linux-arm64", "source", "docker"] as ReleaseKind[]) {
  const stage = join(output, "stage", kind);
  mkdirSync(stage, { recursive: true });
  for (const input of releaseInputs(kind, tracked)) copy(join(root, input.from), join(stage, input.to));
  if (kind === "docker") {
    const manual = "# ZcodeKnight v" + version + " — Docker\n\n本目录是独立 Docker 部署包，不含 Windows/Linux 裸二进制或 node_modules。\n\n```sh\ncd docker\ndocker compose up -d --build\n```\n\n使用 oven/bun:1.4.2 在容器内原生编译。主机目录 `data/`、`config/` 为运行状态，不随包分发；升级时保留现有这两个目录。端口仅映射到主机 loopback。检查更新不会自动替换镜像。\n";
    writeFileSync(join(stage, "docker/README.md"), manual, "utf8");
  } else if (kind !== "source") {
    copy(built.get(kind)!, join(stage, kind === "windows-x64" ? "ZcodeKnight.dat" : "ZcodeKnight"));
    writeFileSync(join(stage, "README.md"), readme(kind), "utf8");
    writeFileSync(join(stage, "config.example.yaml"), EXAMPLE_CONFIG_YAML, "utf8");
    if (kind.startsWith("linux-")) {
      writeFileSync(join(stage, "start.sh"), linuxStart, { encoding: "utf8", mode: 0o755 });
      chmodSync(join(stage, "ZcodeKnight"), 0o755);
    }
  } else {
    writeFileSync(join(stage, "config.example.yaml"), EXAMPLE_CONFIG_YAML, "utf8");
  }
  const filenames = filesIn(stage);
  assertReleaseLayout(kind, filenames);
  const manifestPath = kind === "docker" ? join(stage, "docker/MANIFEST.json") : join(stage, "MANIFEST.json");
  const manifest = { schema: 1, version, kind, sourceCommit: sha, bunVersion: command("bun", ["--version"]).trim(), files: filenames.map((path) => ({ path, bytes: statSync(join(stage, path)).size, sha256: sha256File(join(stage, path)) })) };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const finalPaths = filesIn(stage);
  assertReleaseLayout(kind, finalPaths.filter((p) => p !== "docker/MANIFEST.json"));
  const filename = `ZcodeKnight-${kind}-v${version}.7z`;
  const archive = join(output, filename);
  console.log(`Packing ${filename}: ${finalPaths.length} files`);
  command(sevenZip, ["a", "-t7z", "-mx=5", "-mmt=2", "-scsUTF-8", archive, "."], stage, true);
  command(sevenZip, ["t", archive], root, true);
  const extracted = join(output, "verified", kind);
  mkdirSync(extracted, { recursive: true });
  command(sevenZip, ["x", "-y", archive, `-o${extracted}`]);
  const unpackedFiles = filesIn(extracted);
  if (JSON.stringify(unpackedFiles) !== JSON.stringify(finalPaths)) throw new Error(`${kind}: archive file list differs from stage`);
  for (const file of unpackedFiles) {
    if (sha256File(join(extracted, file)) !== sha256File(join(stage, file))) throw new Error(`${kind}: unpacked hash mismatch ${file}`);
  }
  if (kind === "windows-x64") {
    if (command(join(extracted, "ZcodeKnight.dat"), ["--version"]).trim() !== requiredVersion) throw new Error("Unpacked Windows binary version mismatch");
  }
  assets.push(archive);
  packageChecks.push({ name: filename, kind, files: unpackedFiles.length, bytes: statSync(archive).size, sha256: sha256File(archive), layout: "allowlist passed", extraction: "CRC and all file hashes verified" });
}

for (const target of targets.filter((t) => t.kind.startsWith("linux-"))) {
  const file = join(output, target.filename);
  copy(built.get(target.kind)!, file);
  assets.push(file);
}
const checksumFile = join(output, "SHA256SUMS.txt");
writeFileSync(checksumFile, assets.map((file) => `${sha256File(file)}  ${relative(output, file)}`).join("\n") + "\n", "utf8");
const report = { version, sourceCommit: sha, createdAt: new Date().toISOString(), binaries: binaryChecks, packages: packageChecks, assets: assets.map((file) => ({ name: relative(output, file), bytes: statSync(file).size, sha256: sha256File(file) })) };
writeFileSync(join(output, "release-audit.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`\nRelease ready: ${output}\nChecksums: ${checksumFile}`);
console.log("Linux artifacts were cross-compiled; no Linux runtime execution is claimed.");
