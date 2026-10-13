import { describe, expect, it } from "bun:test";
import { assertReleaseLayout, inspectBinary, releaseInputs } from "./release-layout.ts";

const candidates = [
  "LICENSE", "README.md", "logo.svg", "ZcodeKnight.bat", "stop.bat", "setup.bat", "setup.sh", "make-shortcut.ps1",
  "push-to-github.bat", "使用说明.txt", "策划方案.md", "维护指南.md",
  "docs/zk-support-qr.png", "icons/ZcodeKnight.ico", "server/src/index.ts", "server/src/config/template.ts",
  "server/package.json", "server/bun.lock", "server/scripts/package-release.ts", "server/scripts/release-layout.ts",
  "server/runtime.exe", "ZcodeKnight.dat", "server/ZcodeKnight-YU-linux-x64", "server/ZcodeKnight-YU-linux-arm64",
  "server/node_modules/yaml/index.js", "data/accounts.json", "data/invites.json", "analysis/rewards.html", "config.yaml",
  "docker/Dockerfile", "docker/docker-compose.yml", "docker/package.json", "docker/bun.lock", "docker/src/index.ts",
  "docker/.dockerignore", "docker/README.md", "docker/data/accounts.json", "docker/config/config.yaml",
  "docker/node_modules/undici/index.js", "ZcodeKnight-source-v4.7.13.7z",
];

function paths(kind: Parameters<typeof releaseInputs>[0]) {
  return releaseInputs(kind, candidates).map((file) => file.to);
}

describe("the release carries exactly four assets", () => {
  it("source = complete Windows program + source, with no Docker or Linux binaries", () => {
    const source = paths("source");
    expect(source).toContain("ZcodeKnight.bat");
    expect(source).toContain("server/src/index.ts");
    expect(source).toContain("server/scripts/package-release.ts");
    expect(source).toContain("icons/ZcodeKnight.ico");
    // The three author notes are untracked and must never ship.
    for (const privateDoc of ["使用说明.txt", "策划方案.md", "维护指南.md"]) {
      expect(source).not.toContain(privateDoc);
    }
    expect(source.some((p) => /^docker\/|linux-x64$|linux-arm64$|runtime\.exe|node_modules|analysis\//.test(p))).toBe(false);
    assertReleaseLayout("source", [...source, "config.example.yaml", "ZcodeKnight.dat"]);
  });

  it("Linux contains only its own architecture and start script", () => {
    for (const kind of ["linux-x64", "linux-arm64"] as const) {
      expect(paths(kind).some((p) => /\.bat|\.exe|\.dat|\.ico|\.ps1|docker\/|server\//.test(p))).toBe(false);
      assertReleaseLayout(kind, [...paths(kind), "README.md", "config.example.yaml", "ZcodeKnight", "start.sh"]);
    }
  });

  it("Docker contains only its own build context", () => {
    const docker = paths("docker");
    expect(docker).toContain("docker/Dockerfile");
    expect(docker).toContain("docker/.dockerignore");
    expect(docker).not.toContain("docker/data/accounts.json");
    expect(docker).not.toContain("docker/config/config.yaml");
    assertReleaseLayout("docker", [...docker, "docker/README.md"]);
  });

  it("no package may carry credentials, private notes or a nested archive", () => {
    expect(paths("source").some((p) => /accounts\.json|invites\.json|config\.yaml$/.test(p))).toBe(false);
    for (const kind of ["source", "docker", "linux-x64", "linux-arm64"] as const) {
      expect(paths(kind)).not.toContain("ZcodeKnight-source-v4.7.13.7z");
      expect(paths(kind)).not.toContain("data/accounts.json");
    }
  });

  it("fails when an unexpected payload is inserted", () => {
    const source = [...paths("source"), "config.example.yaml", "ZcodeKnight.dat"];
    for (const unexpected of ["docker/Dockerfile", "server/runtime.exe", "使用说明.txt", "data/accounts.json"]) {
      expect(() => assertReleaseLayout("source", [...source, unexpected])).toThrow();
    }
    expect(() => releaseInputs("source", ["../data/accounts.json"])).toThrow();
    expect(() => releaseInputs("source", ["C:/secret"])).toThrow();
  });
});

describe("binary architecture validation", () => {
  it("reads both Linux ELF machine values", () => {
    for (const [machine, arch] of [[62, "x64"], [183, "arm64"]] as const) {
      const elf = Buffer.alloc(64);
      elf.write("\x7fELF"); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(machine, 18);
      expect(inspectBinary(elf)).toEqual({ format: "ELF", arch });
    }
  });
  it("reads PE x64 and rejects a broken executable header", () => {
    const pe = Buffer.alloc(100);
    pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
    expect(inspectBinary(pe)).toEqual({ format: "PE", arch: "x64" });
    expect(() => inspectBinary(Buffer.alloc(10))).toThrow();
  });
});
