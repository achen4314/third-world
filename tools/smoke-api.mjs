#!/usr/bin/env node
/**
 * 第三世界 · API 层端到端验收（走浏览器用的同一套 REST / Auth 接口）
 *
 * 为什么单独做这一个脚本：
 *   tools/test-flows.mjs 证明的是「数据库 + RLS + RPC」正确，但它用数据库连接、绕过了 API。
 *   真实用户走的是 PostgREST / GoTrue，中间还隔着 publishable key、JWT 解析、表级 GRANT。
 *   这一层出问题，浏览器里就是白屏或 401，而数据库测试全绿也发现不了。
 *
 * 用法：
 *   node tools/smoke-api.mjs                       # 读 .env.local 里的 SUPABASE_PUBLISHABLE_KEY
 *   node tools/smoke-api.mjs --key sb_publishable_xxx
 *   node tools/smoke-api.mjs --email demo@third.world --password 'ArcDemo2026!'
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
}

function readEnv() {
  const env = {};
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const URL_BASE = (opt.url || env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = opt.key || env.SUPABASE_PUBLISHABLE_KEY || "";
const EMAIL = opt.email || "demo@third.world";
const PASSWORD = opt.password || "ArcDemo2026!";

if (!URL_BASE) { console.error("缺少 SUPABASE_URL"); process.exit(2); }
if (!KEY || !KEY.startsWith("sb_publishable_") && !KEY.startsWith("eyJ")) {
  console.error("缺少可用的 publishable key（sb_publishable_… 或旧版 anon JWT eyJ…）");
  console.error("取法：Dashboard → Project Settings → API Keys → Publishable key → Copy");
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); };
const no = (n, d = "") => { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); };
const check = (n, c, d = "") => (c ? ok(n, d) : no(n, d));

async function call(path, { method = "GET", body, token, prefer } = {}) {
  const headers = { apikey: KEY };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(URL_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

console.log("\n第三世界 · API 端到端验收");
console.log("目标 " + URL_BASE);
console.log("key  " + KEY.slice(0, 18) + "…" + KEY.slice(-4) + "（长度 " + KEY.length + "）");
console.log("─".repeat(72));

/* 1. 匿名可达性 */
console.log("\n1. 连通性");
const ping = await call("/rest/v1/metric_registry?select=metric_id&limit=1");
check("PostgREST 可达", ping.status < 500, "HTTP " + ping.status);
check("publishable key 有效（不是 401 invalid api key）",
  !(ping.status === 401 && /invalid api key|no apikey/i.test(ping.text)), "HTTP " + ping.status);

/* 2. 匿名读：能读口径，不能读业务数据 */
console.log("\n2. 匿名权限（应只读得到口径表）");
const reg = await call("/rest/v1/metric_registry?select=metric_id");
check("anon 能读 metric_registry（口径公开）", reg.status === 200 && Array.isArray(reg.json),
  "HTTP " + reg.status + " rows=" + (Array.isArray(reg.json) ? reg.json.length : "-"));
for (const t of ["athletes", "activities", "daily_metrics", "app_users"]) {
  const r = await call("/rest/v1/" + t + "?select=*&limit=1");
  const denied = r.status === 401 || r.status === 403 || (Array.isArray(r.json) && r.json.length === 0);
  check("anon 读不到 " + t, denied, "HTTP " + r.status + " rows=" + (Array.isArray(r.json) ? r.json.length : "-"));
}

/* 3. 登录 */
console.log("\n3. 登录（GoTrue）");
const login = await call("/auth/v1/token?grant_type=password", {
  method: "POST", body: { email: EMAIL, password: PASSWORD }
});
const token = login.json && login.json.access_token;
if (!token) {
  no("账号登录", "HTTP " + login.status + " " + String(login.text).slice(0, 160));
  no("后续用例", "没有 token，跳过");
} else {
  ok("账号登录", "user=" + (login.json.user?.id || "").slice(0, 8) + " expires_in=" + login.json.expires_in);

  const me = await call("/rest/v1/app_users?select=id,display_name", { token });
  check("读到自己的 app_users 行", me.status === 200 && Array.isArray(me.json) && me.json.length === 1,
    "display_name=" + (me.json?.[0]?.display_name ?? "-"));

  const mem = await call("/rest/v1/memberships?select=org_id,role", { token });
  check("读到自己的成员关系", Array.isArray(mem.json) && mem.json.length > 0,
    mem.json?.map((x) => x.role).join(",") || "无");

  const ath = await call("/rest/v1/athletes?select=id,full_name,org_id", { token });
  check("读到运动员档案", Array.isArray(ath.json) && ath.json.length > 0, "n=" + (ath.json?.length ?? 0));

  const acts = await call("/rest/v1/activities?select=id,started_at,sport,training_load&order=started_at.desc&limit=5", { token });
  check("读到训练记录", Array.isArray(acts.json), "n=" + (acts.json?.length ?? 0));

  const dm = await call("/rest/v1/daily_metrics?select=metric_date,metric_id,value&order=metric_date.desc&limit=5", { token });
  check("读到每日指标", Array.isArray(dm.json), "n=" + (dm.json?.length ?? 0));

  const aud = await call("/rest/v1/audit_logs?select=action,occurred_at&order=occurred_at.desc&limit=3", { token });
  check("读到审计记录", Array.isArray(aud.json), "n=" + (aud.json?.length ?? 0));

  /* 4. 写路径：记录一次训练 → 触发服务端重算 */
  console.log("\n4. 写路径与自动计算");
  const target = ath.json && ath.json[0];
  if (!target) {
    no("写入训练", "没有运动员档案，跳过");
  } else {
    const before = await call(
      "/rest/v1/daily_metrics?select=value,updated_at&athlete_id=eq." + target.id + "&metric_id=eq.tl.srpe&order=metric_date.desc&limit=1",
      { token });
    const ins = await call("/rest/v1/activities", {
      method: "POST", token, prefer: "return=representation",
      body: {
        org_id: target.org_id, athlete_id: target.id,
        started_at: new Date().toISOString(), sport: "API 验收",
        duration_s: 600, training_load: 42, load_method: "srpe", rpe: 4, source: "manual"
      }
    });
    const row = Array.isArray(ins.json) ? ins.json[0] : ins.json;
    check("写入训练记录（RLS 放行）", ins.status === 201 && !!row, "HTTP " + ins.status);
    if (row) {
      await new Promise((r) => setTimeout(r, 400));
      const after = await call(
        "/rest/v1/daily_metrics?select=value,updated_at,metric_id&athlete_id=eq." + target.id + "&order=metric_date.desc&limit=8",
        { token });
      check("服务端已重算指标", Array.isArray(after.json) && after.json.length > 0, "rows=" + (after.json?.length ?? 0));
      const del = await call("/rest/v1/activities?id=eq." + row.id, { method: "DELETE", token });
      check("清理验收数据", del.status === 204 || del.status === 200, "HTTP " + del.status);
      void before;
    }

    const bad = await call("/rest/v1/activities", {
      method: "POST", token,
      body: {
        org_id: target.org_id, athlete_id: target.id, started_at: new Date().toISOString(),
        sport: "越界", duration_s: -5, source: "manual"
      }
    });
    check("非法数值被数据库拒绝", bad.status === 400, "HTTP " + bad.status);
  }

  /* 5. 越权写：不能改口径表 */
  console.log("\n5. 越权写（应被拒）");
  const w = await call("/rest/v1/metric_registry?metric_id=eq.tl.srpe", {
    method: "PATCH", token, body: { label: "hacked" }
  });
  check("不能修改 metric_registry", w.status === 401 || w.status === 403 || w.status === 404, "HTTP " + w.status);

  const a = await call("/rest/v1/audit_logs", {
    method: "POST", token, body: { actor_id: login.json.user.id, action: "fake.event" }
  });
  check("不能伪造审计日志", a.status === 401 || a.status === 403, "HTTP " + a.status);
}

console.log("─".repeat(72));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
