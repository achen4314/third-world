#!/usr/bin/env node
/**
 * 第三世界 · publishable key 一键接线 + 验证
 *
 * 为什么要有这个脚本：
 *   「填了 key 但页面还是 DEMO」几乎只有三种原因——贴错文件（前端读的是 prototype/env.js，
 *   不是 .env.local）、只复制到一半（面板右侧把 key 截断）、key 有效但 RLS/账号不通。
 *   这三种在文本上看起来都像「已经填了」。所以这里先把 key 拿去打真实接口，
 *   **通过了才写文件**，写不进去就不会留下一个看起来配好、其实 401 的配置。
 *
 * 用法：
 *   node tools/set-key.mjs --key sb_publishable_xxxxxxxx
 *   node tools/set-key.mjs sb_publishable_xxxxxxxx
 *   node tools/set-key.mjs --key … --dry         # 只验证 + 预览，不写文件
 *   node tools/set-key.mjs --key … --offline     # 只写文件，不联网（离线环境用）
 *   node tools/set-key.mjs --key … --password 'xxx'   # 演示账号密码不是默认值时
 *
 * 安全边界：
 *   只接受 publishable key（或老版 anon JWT）。传入 sb_secret_ 直接拒绝——
 *   那把 key 绕过全部 RLS，写进前端等于把整个库公开。
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/* ── 参数 ─────────────────────────────────────────────────────────── */
const raw = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a.startsWith("--")) {
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) { opt[a.slice(2)] = next; i++; }
    else opt[a.slice(2)] = "true";
  } else positional.push(a);
}
if (!opt.key && positional.length) opt.key = positional[0];

const KEY = String(opt.key || "").trim();
const DRY = opt.dry === "true";
const OFFLINE = opt.offline === "true";

const C = {
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`
};
const mask = (v) => (!v ? "(空)" : v.length <= 26 ? v : v.slice(0, 22) + "…" + v.slice(-4) + ` (len=${v.length})`);

/* ── 格式闸门 ─────────────────────────────────────────────────────── */
if (!KEY) {
  console.error(C.r("缺少 key。"));
  console.error("用法：node tools/set-key.mjs --key sb_publishable_xxxxxxxx");
  console.error(C.d("取法：Dashboard 右上角 Connect → Framework → 点 Copy prompt，整段里有完整 key"));
  process.exit(2);
}

const isPublishable = /^sb_publishable_[A-Za-z0-9_-]+$/.test(KEY);
const isLegacyAnon = /^ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(KEY);

if (/^sb_secret_/.test(KEY)) {
  console.error(C.r("拒绝写入：这是一把 sb_secret_（service_role 级）密钥。"));
  console.error("它绕过全部 RLS，放进浏览器 = 任何访客都能读走整个数据库。");
  console.error(C.d("请改填 Publishable key（sb_publishable_…）。"));
  process.exit(2);
}
if (!isPublishable && !isLegacyAnon) {
  console.error(C.r("格式不认识：" + mask(KEY)));
  console.error("应为 sb_publishable_…（新项目）或 eyJ…（老项目 anon JWT）。");
  console.error(C.d("最常见原因：只复制到一半（面板右侧把 key 截断）、带上了引号/等号/注释。"));
  process.exit(2);
}
if (isPublishable && KEY.length < 34) {
  console.warn(C.y(`注意：长度只有 ${KEY.length}，正常 publishable key 通常 40 位以上，可能被截断了。`));
}

/* ── 读现有配置，拿项目地址 ───────────────────────────────────────── */
const envPath = path.join(ROOT, ".env.local");
const envBefore = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const urlLine = /^SUPABASE_URL=(.+)$/m.exec(envBefore);
const URL_BASE = (urlLine ? urlLine[1] : "https://bffuuxdnztowlwbxjlzp.supabase.co").trim().replace(/\/+$/, "");

const envJsPath = path.join(ROOT, "prototype", "env.js");
const envJsBefore = fs.readFileSync(envJsPath, "utf8");

/* ── 载入现有 .env.local（含演示账号密码，用于登录验证）───────────── */
const envMap = {};
for (const line of envBefore.split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith("#")) continue;
  const i = s.indexOf("=");
  if (i < 1) continue;
  envMap[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const EMAIL = opt.email || envMap.DEMO_EMAIL || "demo@third.world";
const PASSWORD = opt.password || envMap.DEMO_PASSWORD || "ArcDemo2026!";

/* ── 真实接口调用 ─────────────────────────────────────────────────── */
async function call(p, { method = "GET", body, token, apikey = KEY } = {}) {
  const headers = { apikey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(URL_BASE + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text };
}

let pass = 0, fail = 0, warn = 0;
const ok = (n, d = "") => { pass++; console.log(`  ${C.g("✓")} ${n}${d ? "  " + C.d(d) : ""}`); };
const no = (n, d = "") => { fail++; console.log(`  ${C.r("✗")} ${n}${d ? "  " + C.d(d) : ""}`); };
const wr = (n, d = "") => { warn++; console.log(`  ${C.y("!")} ${n}${d ? "  " + C.d(d) : ""}`); };

/* ── ① key 能不能被项目认下来（这一步不过，绝不写文件）───────────── */
let keyValid = null; // null = 未验证（离线）
if (!OFFLINE) {
  console.log(C.b("\n① 先用这把 key 打真实接口"));
  console.log(C.d("   " + URL_BASE));
  try {
    const r = await call("/rest/v1/athletes?select=id&limit=1");
    if (r.status === 200) {
      keyValid = true;
      ok("PostgREST 认这把 key", "HTTP 200");
      if (Array.isArray(r.json) && r.json.length > 0) {
        wr("匿名身份能读到 athletes 行", `返回 ${r.json.length} 行 —— 确认这是有意的公开数据，否则 RLS 有洞`);
      } else {
        ok("匿名身份读不到运动员数据（RLS 生效）", "返回 []");
      }
    } else if (r.status === 401 && /Invalid API key|No API key/i.test(String(r.text))) {
      // 只有这条才是「key 本身不被认」；401 有很多种，不能一律当成 key 坏了
      keyValid = false;
      no("项目不认这把 key", "HTTP 401 " + String(r.json?.message || "").slice(0, 60));
      console.log(C.d("     说明：值不完整或已轮换。最常见是复制时被面板截断 —— 用 Connect → Copy prompt 整段复制。"));
    } else if (r.status === 401 || r.status === 403) {
      // 42501 permission denied：key 有效，只是 anon 这个角色没有任何表的授权 —— 这正是我们想要的状态
      keyValid = true;
      ok("PostgREST 认这把 key", `HTTP ${r.status} 但错误是「权限」而不是「key 无效」`);
      ok("匿名身份被数据库挡住", String(r.json?.message || "").slice(0, 70) + "（符合预期：anon 无任何表授权）");
    } else {
      keyValid = true; // 拿到非鉴权类响应说明 key 至少被接受过
      wr("PostgREST 返回非预期状态", `HTTP ${r.status} ${String(r.text).slice(0, 100)}`);
    }
  } catch (e) {
    keyValid = false;
    no("连不上项目", String(e.message || e).slice(0, 140));
    console.log(C.d("     若本机走代理：确认 https://" + new URL(URL_BASE).host + " 可访问，或用 --offline 只写文件。"));
  }

  if (keyValid === false) {
    console.log("\n" + "─".repeat(72));
    console.log(C.r("key 未通过验证，配置文件没有被改动（避免留下「看起来配好了、其实 401」的状态）。"));
    process.exit(1);
  }
}

/* ── ② 写两处配置 ─────────────────────────────────────────────────── */
let envText = envBefore;
if (/^SUPABASE_PUBLISHABLE_KEY=/m.test(envText)) {
  envText = envText.replace(/^SUPABASE_PUBLISHABLE_KEY=.*$/m, `SUPABASE_PUBLISHABLE_KEY=${KEY}`);
} else {
  if (envText && !envText.endsWith("\n")) envText += "\n";
  envText += `\n# ── C2 已确认（tools/set-key.mjs 写入）────────────────────────────────\nSUPABASE_PUBLISHABLE_KEY=${KEY}\n`;
}
// 把「待补 / 截图只到一半」这类注释改掉，否则下次看到会误以为还缺
envText = envText
  .replace(/^#\s*──\s*C2\s*待补.*$/m, "# ── C2 已确认：publishable key（受 RLS 约束，可放浏览器）──────────────")
  .replace(/^#.*截图中只到.*$/m, "# 完整值已由 tools/set-key.mjs 写入（形如 sb_publishable_…）");

const envJs = envJsBefore.replace(
  /SUPABASE_PUBLISHABLE_KEY:\s*"[^"]*"/,
  `SUPABASE_PUBLISHABLE_KEY: "${KEY}"`
);

const changed = [];
if (envText !== envBefore) changed.push(".env.local");
if (envJs !== envJsBefore) changed.push("prototype/env.js");

console.log(C.b("\n② 写入配置"));
if (DRY) {
  console.log(`  ${C.y("dry-run")}：key 有效，${changed.length ? "会改 " + changed.join("、") : "两个文件的值本来就一致"}（未落盘）`);
} else {
  fs.writeFileSync(envPath, envText, "utf8");
  fs.writeFileSync(envJsPath, envJs, "utf8");
  if (changed.length) changed.forEach((f) => console.log(`  ${C.g("✓")} ${f} ← ${mask(KEY)}`));
  else console.log(`  ${C.d("—")} 两处值本来就一致，未改动`);
}

// .gitignore 必须挡住 .env.local，否则库密码会跟代码一起推上去。
// 不能只找 ".env.local" 这一行字：仓库里用的是 *.local 这种通配，得交给 git 判断。
let ignored = null;
try {
  execSync("git check-ignore -q .env.local", { cwd: ROOT, stdio: "ignore" });
  ignored = true;
} catch { ignored = false; }
console.log(ignored === true
  ? `  ${C.g("✓")} .gitignore 已忽略 .env.local（里面是库密码）`
  : `  ${C.y("!")} .env.local 没有被 .gitignore 忽略 —— 里面有数据库密码，请先补一行 .env.local`);

/* ── ③ Auth 配置与登录链路 ────────────────────────────────────────── */
if (!OFFLINE) {
  console.log(C.b("\n③ Auth 与登录链路"));

  try {
    const r = await call("/auth/v1/settings");
    if (r.status === 200 && r.json) {
      ok("Auth 设置可读", "HTTP 200");
      if (r.json.mailer_autoconfirm === true) ok("邮箱确认已关闭（注册完直接有 session）");
      else wr("邮箱确认仍开着（mailer_autoconfirm=false）",
        "→ Authentication → Sign In / Providers → Email → Confirm email 关掉");
      if (r.json.disable_signup === true) wr("注册被全局禁用（disable_signup=true）", "新用户注册会被拒");
      // email: false 意味着「邮箱+密码」这种登录方式整个是关的，注册和登录都会失败
      if (r.json.external && r.json.external.email === false) {
        wr("Email 登录方式未启用（external.email=false）",
          "→ Authentication → Sign In / Providers → Email → 打开 Enable Email provider");
      }
      const ext = Object.keys(r.json.external || {}).filter((k) => r.json.external[k]);
      console.log(C.d("     已启用登录方式：" + (ext.length ? ext.join(", ") : "仅邮箱密码")));
    } else {
      wr("Auth 设置读取失败", `HTTP ${r.status}`);
    }
  } catch (e) {
    wr("Auth 端点不可达", String(e.message || e).slice(0, 120));
  }

  let token = null;
  try {
    const r = await call("/auth/v1/token?grant_type=password", {
      method: "POST", body: { email: EMAIL, password: PASSWORD }
    });
    if (r.status === 200 && r.json?.access_token) {
      token = r.json.access_token;
      ok("演示账号密码登录成功", EMAIL + " · " + (r.json.user?.role || "authenticated"));
    } else {
      wr("演示账号登录未通过", `HTTP ${r.status} ${String(r.json?.error_description || r.json?.msg || r.text).slice(0, 80)}`);
      console.log(C.d("     若是 Invalid login credentials：密码不是默认值，加 --password '真实密码'。"));
    }
  } catch (e) {
    wr("登录请求失败", String(e.message || e).slice(0, 120));
  }

  if (token) {
    const a = await call("/rest/v1/athletes?select=id,full_name&limit=3", { token });
    if (a.status === 200 && Array.isArray(a.json) && a.json.length) ok("登录后可读自己的运动员档案", `${a.json.length} 行`);
    else wr("登录后读不到运动员档案", `HTTP ${a.status} —— memberships 未建或 RLS 策略不匹配`);

    const m = await call("/rest/v1/daily_metrics?select=metric_id,value,metric_date&order=metric_date.desc&limit=3", { token });
    if (m.status === 200 && Array.isArray(m.json) && m.json.length) ok("登录后可读指标数据", `${m.json.length} 行，最新 ${m.json[0].metric_date}`);
    else wr("登录后指标为空", `HTTP ${m.status} —— 库里有数据吗？跑 node tools/seed-demo.mjs`);

    const w = await call("/rest/v1/activities?select=id,started_at,training_load&limit=1", { token });
    if (w.status === 200 && Array.isArray(w.json) && w.json.length) ok("登录后可读训练记录", `${w.json.length} 行`);
    else wr("登录后训练记录为空", `HTTP ${w.status}`);
  }
}

/* ── ④ 结论 ───────────────────────────────────────────────────────── */
console.log("\n" + "─".repeat(72));
console.log(`${C.b("结果")}：${C.g(pass + " 通过")} / ${fail ? C.r(fail + " 失败") : "0 失败"} / ${warn ? C.y(warn + " 需注意") : "0 需注意"}`);

if (fail === 0) {
  console.log(`
${C.g("key 已接好，前端不再是 DEMO。")}

  打开：${C.c("http://127.0.0.1:8799/index.html")}
  ${C.d("（不要带 ?sburl= / ?sbkey= 参数，那两个只给 mock 用）")}

  页面上应出现：${C.b("已连接真实库")} 与标签 ${C.b("真实数据 · RLS 生效")}
  若仍显示「DEMO 演示数据」：硬刷新（Cmd+Shift+R），env.js 被缓存了。
`);
} else {
  console.log(C.y("\n有失败项。key 本身已通过验证，剩下的是配置或数据问题，按上面 ✗ 的提示处理。"));
  process.exit(1);
}
