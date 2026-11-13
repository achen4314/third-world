#!/usr/bin/env node
/* 第三世界 · 环境变量校验与连通性自检
 *
 * 用法：
 *   node tools/check-env.mjs            # 只做本地格式校验
 *   node tools/check-env.mjs --probe    # 追加真实网络探测（不写库、只读）
 *
 * 设计原则：
 *   1. 只读。不创建、不修改远端任何数据。
 *   2. 只打印掩码值，绝不打印完整密钥。
 *   3. 缺值报「缺失」，格式错报「无效」，两者分开，避免把「没配」误判成「配错」。
 *   4. 退出码：0 全部通过 / 1 存在 P0 缺失或无效 / 2 探测失败但配置合法
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = process.argv.includes("--probe");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY;
const paint = (s, c) => (useColor ? c + s + C.reset : s);

if (HELP) {
  console.log(`用法: node tools/check-env.mjs [--probe] [--help]

  --probe   追加真实网络探测：Auth 健康、PostgREST 可达、迁移是否已推送（只读）
  --help    显示本帮助

读取顺序: 进程环境变量 > .env.local > .env
模板见 .env.example，真实值写 .env.local（已被 .gitignore 忽略）。`);
  process.exit(0);
}

/* ── 1. 解析 env 文件 ──────────────────────────────────────────────── */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const files = [".env", ".env.local"].map(f => path.join(ROOT, f));
const fromFiles = Object.assign({}, ...files.map(parseEnvFile));
const env = Object.assign({}, fromFiles, process.env); // 进程变量优先级最高
const loadedFrom = files.filter(fs.existsSync).map(f => path.basename(f));

/* ── 2. 掩码 ──────────────────────────────────────────────────────── */
function mask(v) {
  if (!v) return paint("（空）", C.dim);
  if (v.length <= 12) return "*".repeat(v.length) + paint(` (len=${v.length})`, C.dim);
  return v.slice(0, 8) + "…" + v.slice(-4) + paint(` (len=${v.length})`, C.dim);
}

/* ── 3. 断言收集 ──────────────────────────────────────────────────── */
const rows = [];
function add(level, id, key, msg) {
  rows.push({ level, id, key, msg, value: env[key] });
}
const OK = "ok", MISS = "missing", BAD = "invalid", WARN = "warn", SKIP = "skip";

const isJwt = v => /^ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
const isPublishable = v => /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(v);
const isSecret = v => /^sb_secret_[A-Za-z0-9_-]{10,}$/.test(v);

/* C1 项目地址 */
let projectRef = "";
const url = env.SUPABASE_URL;
if (!url) {
  add(MISS, "C1", "SUPABASE_URL", "未配置项目地址，API 与 Auth 无基址");
} else if (!/^https:\/\/[^/]+$/.test(url)) {
  add(BAD, "C1", "SUPABASE_URL", "必须是 https:// 开头且不带尾斜杠");
} else {
  let host = "";
  try { host = new URL(url).hostname; } catch { host = ""; }
  const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
  if (m) {
    projectRef = m[1];
    add(OK, "C1", "SUPABASE_URL", `project-ref = ${projectRef}`);
  } else if (host.endsWith(".supabase.co")) {
    add(WARN, "C1", "SUPABASE_URL", `host 是 ${host}，不符合标准 20 位 ref 形态，请确认不是拼错`);
  } else {
    add(WARN, "C1", "SUPABASE_URL", `自定义域名 ${host}：需自行确认 CORS 与 Auth 回调已配`);
  }
}

/* C1b ref 一致性 */
if (env.SUPABASE_PROJECT_REF) {
  if (!projectRef) {
    projectRef = env.SUPABASE_PROJECT_REF;
    add(OK, "C1", "SUPABASE_PROJECT_REF", `取自显式配置 = ${projectRef}`);
  } else if (env.SUPABASE_PROJECT_REF === projectRef) {
    add(OK, "C1", "SUPABASE_PROJECT_REF", "与 URL 中的 ref 一致");
  } else {
    add(BAD, "C1", "SUPABASE_PROJECT_REF", `与 URL 不一致：配置 ${env.SUPABASE_PROJECT_REF} vs URL ${projectRef}`);
  }
} else if (projectRef) {
  add(WARN, "C1", "SUPABASE_PROJECT_REF", "未填，已从 URL 推断；建议显式写出避免歧义");
}

/* C6 区域 */
const region = env.SUPABASE_REGION;
if (!region) {
  add(MISS, "C6", "SUPABASE_REGION", "未填区域，无法做数据出境判定（docs/06 D3）");
} else if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region) && region !== "localhost") {
  add(WARN, "C6", "SUPABASE_REGION", `「${region}」不像标准区域码（如 us-east-1）`);
} else if (region.startsWith("us-")) {
  add(WARN, "C6", "SUPABASE_REGION", `${region} 在境外：触发数据出境判定，且与境内 ICP 备案要求冲突`);
} else if (region.startsWith("cn-")) {
  add(OK, "C6", "SUPABASE_REGION", `${region}（境内）`);
} else {
  add(OK, "C6", "SUPABASE_REGION", region);
}

/* C2 前端 key */
const pub = env.SUPABASE_PUBLISHABLE_KEY || "";
const anon = env.SUPABASE_ANON_KEY || "";
if (pub && anon) {
  add(WARN, "C2", "SUPABASE_PUBLISHABLE_KEY", "同时填了新旧两种 key，建议只留一种，避免排查时混淆");
} else if (!pub && !anon) {
  add(MISS, "C2", "SUPABASE_PUBLISHABLE_KEY", "前端无法初始化 SDK（新项目用 sb_publishable_，老项目用 anon JWT）");
} else if (pub) {
  if (isPublishable(pub)) add(OK, "C2", "SUPABASE_PUBLISHABLE_KEY", "新格式 sb_publishable_，对应 anon 角色，受 RLS 约束");
  else if (isJwt(pub)) add(WARN, "C2", "SUPABASE_PUBLISHABLE_KEY", "填的是 JWT，键名与值形态不符，请确认这是 anon 而不是 service_role");
  else add(BAD, "C2", "SUPABASE_PUBLISHABLE_KEY", "既不是 sb_publishable_ 也不是 JWT 形态");
} else {
  if (isJwt(anon)) add(OK, "C2", "SUPABASE_ANON_KEY", "anon JWT 形态正确");
  else if (isPublishable(anon)) add(WARN, "C2", "SUPABASE_ANON_KEY", "值是 sb_publishable_ 格式，建议改填到 SUPABASE_PUBLISHABLE_KEY");
  else add(BAD, "C2", "SUPABASE_ANON_KEY", "不是合法 JWT");
}

/* C3 服务端密钥 —— 永远不打印值 */
const sec = env.SUPABASE_SECRET_KEY || "";
const srv = env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!sec && !srv) {
  add(MISS, "C3", "SUPABASE_SECRET_KEY", "服务端管理操作（建用户、批处理）不可用；迁移不受影响");
} else if (sec && srv) {
  add(WARN, "C3", "SUPABASE_SECRET_KEY", "同时填了新旧两种，建议只留一种");
} else if (sec) {
  add(isSecret(sec) ? OK : BAD, "C3", "SUPABASE_SECRET_KEY", isSecret(sec) ? "sb_secret_ 格式正确，仅限服务端" : "不是 sb_secret_ 形态");
} else {
  add(isJwt(srv) ? OK : BAD, "C3", "SUPABASE_SERVICE_ROLE_KEY", isJwt(srv) ? "service_role JWT 形态正确，仅限服务端" : "不是合法 JWT");
}

/* C2/C3 交叉污染检查：这是最容易出事的错误 */
if (pub && srv && pub === srv) {
  add(BAD, "C3", "SUPABASE_SECRET_KEY", "前端 key 与服务端 key 完全相同 —— 高风险，务必确认是否把 service_role 填到了前端");
}
if (pub && isJwt(pub) && srv && pub.slice(0, 20) === srv.slice(0, 20)) {
  add(BAD, "C3", "SUPABASE_SECRET_KEY", "两个 JWT 前缀高度相似，疑似同一把密钥被填了两处");
}

/* C4 连接串 */
for (const [id, key, wantPort, label] of [
  ["C4", "DATABASE_URL", "6543", "pooler"],
  ["C4", "DIRECT_URL", "5432", "直连"],
]) {
  const v = env[key];
  if (!v) {
    add(MISS, id, key, `未配置：supabase db push 与迁移执行需要${label}串`);
    continue;
  }
  let u;
  try { u = new URL(v); } catch { u = null; }
  if (!u || !/^postgres(ql)?:$/.test(u.protocol)) {
    add(BAD, id, key, "不是 postgresql:// 连接串");
  } else if (/[<>\s]/.test(v)) {
    add(BAD, id, key, "仍含 <占位符>，请替换为真实值");
  } else if (u.port && u.port !== wantPort) {
    add(WARN, id, key, `端口 ${u.port}，${label}通常为 ${wantPort}`);
  } else {
    add(OK, id, key, `${u.hostname}:${u.port || "(默认)"} · 库 ${u.pathname.slice(1)}`);
  }
}

/* C7 套餐 */
const plan = env.SUPABASE_PLAN;
if (!plan) add(SKIP, "C7", "SUPABASE_PLAN", "未填，默认按 free 的限额处理");
else if (["free", "pro"].includes(plan)) add(OK, "C7", "SUPABASE_PLAN", plan === "free" ? "free：无每日备份 / 无 PITR / 闲置 7 天暂停" : "pro：有备份与分支能力");
else add(BAD, "C7", "SUPABASE_PLAN", `只接受 free 或 pro，当前「${plan}」`);

/* 回调地址 */
const red = env.ALLOWED_REDIRECT_URLS;
if (!red) add(SKIP, "", "ALLOWED_REDIRECT_URLS", "未填：邮件确认与 OAuth 回调会失败（C9）");
else {
  const bad = red.split(",").map(s => s.trim()).filter(Boolean).filter(s => { try { const x = new URL(s); return !/^https?:$/.test(x.protocol); } catch { return true; } });
  add(bad.length ? BAD : OK, "", "ALLOWED_REDIRECT_URLS", bad.length ? `非法地址：${bad.join(", ")}` : `${red.split(",").length} 个回调地址`);
}

/* ── 4. 输出表 ────────────────────────────────────────────────────── */
const ICON = { ok: paint("✓", C.green), missing: paint("✗", C.red), invalid: paint("!", C.red), warn: paint("△", C.yellow), skip: paint("–", C.dim) };
const LABEL = { ok: "通过", missing: "缺失", invalid: "无效", warn: "注意", skip: "跳过" };

console.log("");
console.log(paint("第三世界 · 环境校验", C.bold) + paint(`  (来源: ${loadedFrom.join(" + ") || "无 env 文件"}${Object.keys(process.env).length ? " + 进程变量" : ""})`, C.dim));
console.log("─".repeat(96));
for (const r of rows) {
  const id = (r.id || "—").padEnd(3);
  const key = r.key.padEnd(26);
  const st = LABEL[r.level].padEnd(4);
  console.log(`${ICON[r.level]} ${id} ${key} ${paint(st, r.level === "ok" ? C.green : r.level === "warn" ? C.yellow : C.red)}  ${r.msg}`);
  if (r.value && r.level !== "ok" && /KEY|SECRET/.test(r.key)) console.log(`${" ".repeat(7)}${paint("值: " + mask(r.value), C.dim)}`);
}
console.log("─".repeat(96));

const p0 = rows.filter(r => ["C1", "C2", "C3", "C4", "C6"].includes(r.id));
const p0Bad = p0.filter(r => r.level === MISS || r.level === BAD);
const warnCount = rows.filter(r => r.level === WARN).length;

console.log(`P0 项 ${p0.length} · 未通过 ${p0Bad.length} · 需注意 ${warnCount}`);

/* ── 5. 网络探测（只读）──────────────────────────────────────────── */
let probeFailed = false;
if (PROBE) {
  console.log("");
  console.log(paint("连通性探测（只读，不写库）", C.bold));
  console.log("─".repeat(96));
  const key = pub || anon;
  if (!url || !key) {
    console.log(`${paint("–", C.dim)} 跳过：缺少 SUPABASE_URL 或前端 key，无法带 apikey 探测`);
  } else {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const hit = async (label, pathname, expect) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url + pathname, { headers, signal: AbortSignal.timeout(15000) });
        const ms = Date.now() - t0;
        const body = await res.text();
        const okStatus = res.status === expect;
        console.log(`${okStatus ? paint("✓", C.green) : paint("✗", C.red)} ${label.padEnd(22)} HTTP ${res.status} · ${ms}ms`);
        if (!okStatus) { probeFailed = true; console.log(`${" ".repeat(4)}${paint(body.slice(0, 220), C.dim)}`); }
        return { status: res.status, body };
      } catch (e) {
        probeFailed = true;
        console.log(`${paint("✗", C.red)} ${label.padEnd(22)} 失败：${e.name === "TimeoutError" ? "超时 15s（区域境外可达性差，或本地网络受限）" : e.message}`);
        return null;
      }
    };

    await hit("Auth 健康", "/auth/v1/health", 200);
    await hit("PostgREST 根", "/rest/v1/", 200);

    /* 用服务端密钥判断迁移是否已推送：查 users 表 */
    const adminKey = sec || srv;
    if (adminKey) {
      const t0 = Date.now();
      try {
        const res = await fetch(url + "/rest/v1/users?select=id&limit=1", {
          headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}` },
          signal: AbortSignal.timeout(15000),
        });
        const ms = Date.now() - t0;
        const body = await res.text();
        if (res.status === 200) {
          console.log(`${paint("✓", C.green)} ${"迁移状态".padEnd(22)} 已推送：users 表可读（${ms}ms）`);
        } else if (res.status === 404 || /PGRST205|does not exist|schema cache/i.test(body)) {
          console.log(`${paint("△", C.yellow)} ${"迁移状态".padEnd(22)} 未推送：users 表不存在 → 需执行 supabase db push`);
        } else {
          probeFailed = true;
          console.log(`${paint("✗", C.red)} ${"迁移状态".padEnd(22)} HTTP ${res.status} · ${body.slice(0, 180)}`);
        }
      } catch (e) {
        probeFailed = true;
        console.log(`${paint("✗", C.red)} ${"迁移状态".padEnd(22)} 失败：${e.message}`);
      }
    } else {
      console.log(`${paint("–", C.dim)} ${"迁移状态".padEnd(22)} 跳过：需要 C3 服务端密钥才能查表`);
    }
  }
  console.log("─".repeat(96));
}

/* ── 6. 结论 ─────────────────────────────────────────────────────── */
console.log("");
if (p0Bad.length) {
  console.log(paint(`结论：未就绪。缺 ${p0Bad.filter(r => r.level === MISS).length} 项、错 ${p0Bad.filter(r => r.level === BAD).length} 项，见上方 ✗ / ! 行。`, C.red));
  console.log(paint("补齐方式：见 docs/06 §3.1（C1–C11），真实值写入 .env.local，不要提交。", C.dim));
  process.exit(1);
}
if (probeFailed) {
  console.log(paint("结论：本地配置合法，但网络探测有失败项 —— 可能是区域境外、或迁移未推送。", C.yellow));
  process.exit(2);
}
console.log(paint("结论：P0 配置齐备" + (PROBE ? "，且远端探测通过。" : "。（加 --probe 可验证远端）"), C.green));
process.exit(0);
