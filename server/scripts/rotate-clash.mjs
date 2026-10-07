/**
 * Clash 出口轮换：每调一次切到下一个日本节点（round-robin，状态存 data/）。
 * 用法：node scripts/rotate-clash.mjs  → 切一格并打印新节点
 *      node scripts/rotate-clash.mjs --peek → 只显示当前，不切
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE = join(ROOT, "data", "clash-rotate.json");
const SECRET = (process.env.CLASH_SECRET ?? readSecret()) || "";
const GROUP = process.env.CLASH_GROUP ?? "🚀节点选择";
const API = "http://127.0.0.1:9097";

function readSecret() {
  try {
    const cfg = readFileSync(join(process.env.APPDATA ?? "", "io.github.clash-verge-rev.clash-verge-rev", "config.yaml"), "utf8");
    return (cfg.match(/^secret:\s*(.+)$/m)?.[1] ?? "").trim().replace(/"/g, "");
  } catch { return ""; }
}
const H = { authorization: `Bearer ${SECRET}` };
const enc = (s) => encodeURIComponent(s);

const nodes = (await (await fetch(`${API}/proxies/${enc(GROUP)}`, { headers: H })).json()).all
  .filter(n => /日本东京|AWS日本/.test(n));

const peek = process.argv.includes("--peek");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { idx: -1 };
const next = peek ? (state.idx + 1) % nodes.length : ((state.idx + 1) % nodes.length + nodes.length) % nodes.length;

if (!peek) {
  const r = await fetch(`${API}/proxies/${enc(GROUP)}`, {
    method: "PUT", headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ name: nodes[next] }),
  });
  if (!r.ok && r.status !== 204) { console.error(`切换失败: ${r.status}`); process.exit(1); }
  state.idx = next;
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}
console.log((peek ? "[peek] 下一格: " : "已切换 → ") + nodes[state.idx === undefined ? next : state.idx]);
console.log(`(${nodes.indexOf(nodes[state.idx === undefined ? next : state.idx]) + 1}/${nodes.length} 个日本节点)`);
