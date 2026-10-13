/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 *
 * Per-model aggregates on the overview.
 *
 * Field report 2026-10-13: the overview showed SEVERAL rows for one model
 * ("概览页面出现很多个相同的一个模型数据") because the aggregate map was keyed by
 * the raw client string — `GLM-5.3`, `glm-5.3` and `Glm-5.3` became three
 * separate entries. These tests pin the canonicalization on all three paths:
 * recording, restoring a persisted snapshot, and the snapshot the panel reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "zk-stats-"));
process.env.ZCODE_KNIGHT_STORE_DIR = TMP;
process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = join(TMP, "legacy");

const { recordRequest, requestStats, resetRequestStats } = await import("./request-stats.js");
const { dataFile } = await import("../paths.js");

function rec(over: Partial<Parameters<typeof recordRequest>[0]> = {}) {
  return {
    reqId: over.reqId ?? `#${Math.random().toString(36).slice(2, 8)}`,
    started: Date.now(),
    format: "openai" as const,
    model: "glm-5.3",
    stream: false,
    status: 200,
    ttfbMs: 100,
    totalMs: 200,
    tokens: 10,
    accountName: "acct",
    ip: "127.0.0.1",
    path: "/v1/chat/completions",
    userAgent: "test",
    authorized: true,
    ...over,
  };
}

beforeEach(() => {
  resetRequestStats();
});

afterEach(() => {
  resetRequestStats();
});

describe("one model, one row — regardless of how the client spelled it", () => {
  it("merges GLM-5.3 / glm-5.3 / Glm-5.3 into a single aggregate", () => {
    recordRequest(rec({ model: "glm-5.3" }));
    recordRequest(rec({ model: "GLM-5.3" }));
    recordRequest(rec({ model: "Glm-5.3" }));

    const { perModel } = requestStats();
    expect(perModel).toHaveLength(1);
    expect(perModel[0]!.total).toBe(3);
    // Display keeps the first spelling seen, not the lowercase key.
    expect(perModel[0]!.model).toBe("glm-5.3");
  });

  it("keeps genuinely different models apart", () => {
    recordRequest(rec({ model: "glm-5.3" }));
    recordRequest(rec({ model: "GLM-5.3-FLASH" }));
    const models = requestStats().perModel.map((m) => m.model).sort();
    expect(models).toHaveLength(2);
  });

  it("counts successes and failures onto the same merged row", () => {
    recordRequest(rec({ model: "GLM-5.3", status: 200 }));
    recordRequest(rec({ model: "glm-5.3", status: 502 }));
    const row = requestStats().perModel[0]!;
    expect(row.total).toBe(2);
    expect(row.succeeded).toBe(1);
    expect(row.failed).toBe(1);
  });

  it("folds a legacy snapshot's mixed-case rows together on load", async () => {
    // A stats file written before the fix holds three rows for one model.
    // Loading it must MERGE them — otherwise the panel keeps showing the
    // duplicates until the file happens to be rewritten.
    resetRequestStats();
    const legacy = {
      total: 3, succeeded: 3, failed: 0, ttfbSum: 300, tokensTotal: 30,
      recent: [],
      perModel: [
        ["glm-5.3", { total: 1, succeeded: 1, failed: 0, ttfbSum: 100, ttfbCount: 1, tokensTotal: 10 }],
        ["GLM-5.3", { total: 1, succeeded: 1, failed: 0, ttfbSum: 100, ttfbCount: 1, tokensTotal: 10 }],
        ["Glm-5.3", { total: 1, succeeded: 1, failed: 0, ttfbSum: 100, ttfbCount: 1, tokensTotal: 10 }],
      ],
    };
    writeFileSync(dataFile("request-stats.json"), JSON.stringify(legacy), "utf-8");
    const mod = await import(`./request-stats.js?reload=${Date.now()}`) as typeof import("./request-stats.js");
    const { perModel } = mod.requestStats();
    expect(perModel).toHaveLength(1);
    expect(perModel[0]!.total).toBe(3);
    expect(perModel[0]!.tokensTotal).toBe(30);
  });
});
