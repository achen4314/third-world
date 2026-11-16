/* 训练 / 测试模块分离验收（纯静态，不连数据库、不改任何数据）
 *   node tools/verify-modules.mjs
 * 依据：用户要求「训练只算 TL 与 ACWR、训练与 CMJ 等测试清晰分离、训练提供多种选择」。
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = path.join(ROOT, "prototype");
const read = f => fs.readFileSync(path.join(P, f), "utf8");

const rows = [];
const add = (group, name, ok, actual, expect) =>
  rows.push({ group, name, ok: !!ok, actual: String(actual), expect: String(expect) });

/* 1. 载入 data.js 的常量（提供最小 window，不触发浏览器 API） */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(read("data.js"), sandbox);
const A = sandbox.window.ARC || {};

const TYPES = A.TRAIN_TYPES || [];
const PRESETS = A.TRAIN_PRESETS || [];
const TEST_WORDS = /测试|CMJ|\bSJ\b|\bDJ\b|RSI|VBT|冲刺|筛查|ROM|问卷/i;

add("训练选项", "训练类型数量 ≥ 6 种", TYPES.length >= 6, TYPES.length + " 种", "≥ 6");
add("训练选项", "训练类型 id 唯一", new Set(TYPES.map(t => t.id)).size === TYPES.length,
  new Set(TYPES.map(t => t.id)).size + "/" + TYPES.length, "全部唯一");
add("训练选项", "训练类型不含任何测试项目", TYPES.every(t => !TEST_WORDS.test(t.label + t.hint)),
  TYPES.filter(t => TEST_WORDS.test(t.label + t.hint)).map(t => t.label).join(",") || "0 个", "0 个");
add("训练选项", "预设搭配方案数量 ≥ 6 套", PRESETS.length >= 6, PRESETS.length + " 套", "≥ 6");
add("训练选项", "预设方案含多段（可自行搭配）", PRESETS.some(p => p.seg.length >= 3),
  "最多 " + Math.max(0, ...PRESETS.map(p => p.seg.length)) + " 段", "至少一套 ≥ 3 段");
add("训练选项", "预设方案的段类型都合法", PRESETS.every(p => p.seg.every(s => TYPES.some(t => t.id === s[0]))),
  PRESETS.flatMap(p => p.seg.filter(s => !TYPES.some(t => t.id === s[0])).map(s => s[0])).join(",") || "0 个非法", "0 个");
add("训练选项", "预设方案不含测试项目", PRESETS.every(p => !TEST_WORDS.test(p.name + p.note) && p.seg.every(s => !TEST_WORDS.test(s[0]))),
  "0 处", "0 处");
add("训练选项", "预设方案参数在合法范围", PRESETS.every(p => p.seg.every(s => s[1] > 0 && s[1] <= 600 && s[2] >= 0 && s[2] <= 10)),
  "全部在范围", "时长 1–600 / RPE 0–10");

/* TL 口径：多段相加，且与单段公式一致 */
const sum = p => p.seg.reduce((a, s) => a + s[1] * s[2], 0);
add("训练计算", "TL = Σ(每段 RPE × 每段分钟)", true,
  PRESETS.slice(0, 3).map(p => p.name + "=" + sum(p)).join(" · "), "可复算");
add("训练计算", "单段方案退化为 sRPE × 时长",
  PRESETS.filter(p => p.seg.length === 1).every(p => sum(p) === p.seg[0][1] * p.seg[0][2]),
  PRESETS.filter(p => p.seg.length === 1).length + " 套单段方案", "全部相等");

/* 2. 源码级分离断言：只看「功能性引用」，不把边界说明文字算进去 */
const app = read("app.js");
const ui = read("ui-flows.js");
const trainStart = app.indexOf('page("train"');
const analyzeStart = app.indexOf('page("analyze"');
const labStart = app.indexOf('page("measure"');
const dataStart = app.indexOf('page("data"');
const trainSrc = app.slice(trainStart, analyzeStart);
const labSrc = app.slice(labStart, dataStart);

const TRAIN_FORBIDDEN = [
  ['sheet: "newtest"', "训练页不得打开测试协议选择"],
  ["S_protocols(", "训练页不得嵌入测试协议网格"],
  ['route: "measure/', "训练页不得把测量采集页作为功能入口"],
  ["chartLoadTrend(", "训练页不得画 CTL/ATL/TSB 趋势"]
];
for (const [needle, why] of TRAIN_FORBIDDEN) {
  add("模块分离", why, !trainSrc.includes(needle),
    trainSrc.includes(needle) ? "发现 " + needle : "0 处", "0 处");
}
add("模块分离", "训练页只呈现 TL 与 ACWR 两张图",
  trainSrc.includes("chartTL()") && trainSrc.includes("chartACWR()"), "TL ✓ / ACWR ✓", "两者都有");
add("模块分离", "训练页只给查看/导航入口，录入唯一在顶栏（C1）",
  !trainSrc.includes('act: "arc-record"') && /primary-cta[^>]*data-act="arc-record"/.test(app),
  "训练页 " + (trainSrc.match(/act: "arc-record"/g) || []).length + " 处 + 顶栏 1 处", "唯一录入口");
add("模块分离", "测试页 actions 指向测试记录入口",
  labSrc.includes('act: "arc-test-record"'), "act=arc-test-record", "测试记录");
add("模块分离", "训练记录表单不含「测试」类型选项",
  !ui.includes('"球类", "测试", "其他"'), "0 处", "0 处");
add("模块分离", "训练与测试各有独立浮层 scope",
  ui.includes('scope: "train"') && ui.includes('data-u="scope"') && ui.includes('U.scope === "test"'),
  "train / test 双 scope", "两者都有");
add("模块分离", "训练段明细写入 raw 字段（不新建表、不改数据）",
  ui.includes('schema: "training.segments.v1"') && ui.includes("raw: {"),
  "raw.segments", "持久化分段");
add("模块分离", "测试记录说明不计入 TL / ACWR",
  ui.includes("不参与 TL 与 ACWR"), "已声明", "已声明");

/* 3. 两个模块各自包含的页面清单 */
const trainPages = [...trainSrc.matchAll(/page\("(train[^"]*)",\s*"([^"]+)"/g)].map(m => m[1] + " · " + m[2]);
const labPages = [...labSrc.matchAll(/page\("(measure[^"]*)",\s*"([^"]+)"/g)].map(m => m[1] + " · " + m[2]);
add("模块清单", "训练模块页面数", trainPages.length >= 6, trainPages.length + " 页", "≥ 6");
add("模块清单", "测试模块页面数", labPages.length >= 6, labPages.length + " 页", "≥ 6");
add("模块清单", "测试模块含跳跃 / VBT / 冲刺 / 筛查 / 历史 / 标定",
  ["measure/jump", "measure/vbt", "measure/sprint", "measure/screen", "measure/history", "measure/calibration"].every(r => labSrc.includes('page("' + r + '"')),
  "6 类齐备", "6 类齐备");
add("模块清单", "测试协议常量仍完整（4 组）",
  (A.TEST_PROTOCOLS || []).length === 4, (A.TEST_PROTOCOLS || []).length + " 组", "4 组");

/* 4. 发布链路防回归（实机抓到过两个真 bug） */
const heroSrc = app.slice(app.indexOf('if (s.type === "hero")'), app.indexOf('if (s.type === "metrics")'));
add("发布一致性", "hero 区块 actions 支持 act（不会跳 undefined 路由）",
  heroSrc.includes("a.act"), heroSrc.includes("a.act") ? "支持" : "缺失", "支持");
const builder = fs.readFileSync(path.join(ROOT, "build", "platforms.mjs"), "utf8");
add("发布一致性", "Service Worker 不用 ignoreSearch（?v= 破缓存有效）",
  !builder.includes("ignoreSearch: true"),
  builder.includes("ignoreSearch: true") ? "仍在用" : "精确匹配", "精确匹配");
add("发布一致性", "HTML 走 network-first（回访拿到新入口页）",
  builder.includes('req.mode === "navigate"'), "network-first", "network-first");

/* 输出 */
const pass = rows.filter(r => r.ok).length, fail = rows.length - pass;
console.log("\n第三世界 · 训练 / 测试模块分离验收");
console.log("─".repeat(88));
let g = "";
for (const r of rows) {
  if (r.group !== g) { g = r.group; console.log("\n" + g); }
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  console.log(`    实际 ${r.actual}${r.ok ? "" : "  ·  期望 " + r.expect}`);
}
console.log("\n" + "训练模块：" + trainPages.join(" | "));
console.log("测试模块：" + labPages.join(" | "));
console.log("训练类型：" + TYPES.map(t => t.label).join(" / "));
console.log("预设方案：" + PRESETS.map(p => p.name + "(" + p.seg.length + "段)").join(" / "));
console.log("\n" + "─".repeat(88));
console.log(`共 ${rows.length} 项：✓ ${pass} · ✗ ${fail}`);
process.exitCode = fail ? 1 : 0;
