/**
 * ZIP 备份导出测试：config.yaml 必须随包（data 的上一级解析）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBackupZip } from "./export-import.js";
import { readZip } from "./zip.js";

const TMP_ROOT = join(tmpdir(), `zk-export-zip-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(() => {
  tmp = `${TMP_ROOT}-${seq++}`;
  // 模拟部署布局：<root>/config.yaml + <root>/data/accounts.json
  mkdirSync(join(tmp, "data"), { recursive: true });
  process.env.ZCODE_KNIGHT_STORE_DIR = join(tmp, "data");
  writeFileSync(join(tmp, "data", "accounts.json"), '{"encrypted":"x"}');
  writeFileSync(join(tmp, "config.yaml"), 'server:\n  port: 17800\n');
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("exportBackupZip", () => {
  it("includes config.yaml from the deploy root and accounts.json from data/", async () => {
    const zip = await exportBackupZip({ provider: "zai" }, "4.6.8");
    const entries = readZip(zip).map((e) => e.name);
    expect(entries).toContain("accounts.json");
    expect(entries).toContain("config.yaml");
    expect(entries).toContain("manifest.json");
  });
});
