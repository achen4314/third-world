#!/usr/bin/env node
/* 第三世界 · 远程建库（对真实 Supabase 执行 supabase/apply-all.sql）
 *
 * 用法：
 *   node tools/apply-remote.mjs --dry-run       # 只校验连接串与环境，不连库
 *   node tools/apply-remote.mjs --verify-only   # 已建库，只跑自检不重建
 *   node tools/apply-remote.mjs                # 真连库执行
 *
 * 取连接串的顺序：
 *   进程环境变量 DATABASE_URL > .env.local 的 DIRECT_URL > .env.local 的 DATABASE_URL
 *
 * 安全设计：
 *   1. 只打印掩码后的主机与用户名，绝不打印密码。
 *   2. 执行前先探测 public 下是否已有业务表；已有则**拒绝执行**（除非 --force），
 *      避免把已有库的表结构撞坏。--force 会先跑 reset.sql 的等价动作？**不会**，
 *      --force 只是跳过这个保护，仍由 SQL 自身报错兜底。
 *   3. 整段 SQL 自带 begin/commit，失败即回滚。
 *   4. 执行成功后再跑一次自检查询，把 11 项结果打出来。
 *
 * 依赖：pg（npm i）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SQL_FILE = path.join(ROOT, "supabase", "apply-all.sql");
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const VERIFY_ONLY = process.argv.includes("--verify-only");

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

function readEnvLocal() {
  const out = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (v) out[line.slice(0, eq).trim()] = v;
    }
  }
  return out;
}

const envFile = readEnvLocal();
const url = process.env.DATABASE_URL || envFile.DIRECT_URL || envFile.DATABASE_URL || "";

/* ── 1. 连接串检查（不打印密码）────────────────────────────── */
if (!url) {
  console.error(paint("✗ 未找到连接串。", C.red));
  console.error(`  请在 .env.local 里填 DIRECT_URL=（或设进程变量 DATABASE_URL）。`);
  console.error(`  形如：postgresql://postgres.<ref>:<密码>@aws-1-<region>.pooler.supabase.com:5432/postgres`);
  process.exit(1);
}

let u;
try { u = new URL(url); } catch {
  console.error(paint("✗ 连接串不是合法 URI", C.red)); process.exit(1);
}
const isPooler = /pooler\.supabase\.com$/.test(u.hostname);
const port = u.port || "5432";
const user = decodeURIComponent(u.username);
const dbName = u.pathname.slice(1) || "postgres";

console.log("");
console.log(paint("第三世界 · 远程建库", C.bold));
console.log("─".repeat(78));
console.log(`目标主机   ${u.hostname}:${port}${isPooler ? paint("  (池化 / Supavisor)", C.dim) : paint("  (直连)", C.dim)}`);
console.log(`数据库     ${dbName}`);
console.log(`用户       ${user}`);
console.log(`密码       ${"*".repeat(8)}${paint(" (已读取，不显示)", C.dim)}`);
console.log(`端口提示   ${port === "6543" ? paint("⚠ 6543 是事务池化，不适合跑 DDL/多语句事务，请改用 5432 的 Session pooler", C.yellow) : "OK（会话模式，可执行 DDL）"}`);
console.log("─".repeat(78));

if (DRY) {
  console.log(paint("--dry-run：只检查，不连库。", C.dim));
  console.log(`将执行 ${SQL_FILE}（${fs.readFileSync(SQL_FILE, "utf8").split("\n").length} 行）`);
  process.exit(port === "6543" ? 1 : 0);
}

/* ── 2. 连接 ──────────────────────────────────────────────── */
if (port === "6543") {
  console.error(paint("✗ 拒绝在事务池化端口执行建库脚本。请改用 Session pooler（5432）。", C.red));
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false }, // Supabase 要求 TLS；这里是自签/中间证书链，不校验证书链
  connectionTimeoutMillis: 15000,
  statement_timeout: 120000,
});

try {
  await client.connect();
  console.log(paint("✓ 连接成功", C.green));
} catch (e) {
  console.error(paint("✗ 连接失败：" + e.message, C.red));
  if (/ENOTFOUND|getaddrinfo/.test(e.message)) {
    console.error(paint("  → 域名解析失败：直连域名只有 IPv6，且你的 DNS 走了代理 fake-ip。改用池化地址。", C.yellow));
  } else if (/password|authentication/i.test(e.message)) {
    console.error(paint("  → 密码不对。Dashboard → 设置 → 数据库 → 重置数据库密码后重填。", C.yellow));
  } else if (/timeout|ETIMEDOUT/i.test(e.message)) {
    console.error(paint("  → 连接超时：检查代理/防火墙是否放行 5432。", C.yellow));
  }
  process.exit(1);
}

/* ── 3. 预检：库里是否已有业务表 ──────────────────────────── */
if (!VERIFY_ONLY) {
try {
  const pre = await client.query(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')`
  );
  const n = pre.rows[0].n;
  if (n > 0 && !FORCE) {
    console.log(paint(`✗ public 下已有 ${n} 张表，拒绝执行以免撞坏现有结构。`, C.red));
    console.log(paint("  确认要重建：先执行 supabase/reset.sql，或加 --force（仍会因类型已存在而失败）。", C.dim));
    await client.end();
    process.exit(1);
  }
  console.log(`✓ 预检：public 下现有 ${n} 张表${n === 0 ? "（空库，可继续）" : ""}`);
} catch (e) {
  console.error(paint("✗ 预检失败：" + e.message, C.red));
  await client.end();
  process.exit(1);
}

/* ── 4. 执行建库脚本 ──────────────────────────────────────── */
const sql = fs.readFileSync(SQL_FILE, "utf8");
const t0 = Date.now();
try {
  await client.query(sql);
  console.log(paint(`✓ apply-all.sql 执行成功（${Date.now() - t0} ms）`, C.green));
} catch (e) {
  console.error(paint(`✗ 执行失败：${e.code || ""} ${e.message}`, C.red));
  if (e.position) console.error(paint(`  SQL 位置 ${e.position}`, C.dim));
  console.error(paint("  事务已回滚，库应仍是执行前状态。把这段报错原文给我。", C.dim));
  await client.end();
  process.exit(1);
}

} // end if (!VERIFY_ONLY)

/* ── 5. 独立自检（不依赖脚本末尾那张表）────────────────── */
const checks = await client.query(`
  select '业务表（不含分区子表）' as item,
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition)::text as actual, '17' as expect
  union all select '已启用 RLS 的业务表',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition and c.relrowsecurity)::text, '17'
  union all select '未启用 RLS 的业务表（应 0）',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition and not c.relrowsecurity)::text, '0'
  union all select 'RLS 策略',
         (select count(*) from pg_policies where schemaname='public')::text, '37'
  union all select '指标口径',
         (select count(*) from public.metric_registry)::text, '30'
  union all select 'core 口径',
         (select count(*) from public.metric_registry where tier='core')::text, '22'
  union all select 'vendor_aligned 口径',
         (select count(*) from public.metric_registry where tier='vendor_aligned')::text, '8'
  union all select 'device_credentials 策略（应 0）',
         (select count(*) from pg_policies where schemaname='public' and tablename='device_credentials')::text, '0'
  union all select 'audit_logs 可 UPDATE（应 false）',
         has_table_privilege('authenticated','public.audit_logs','UPDATE')::text, 'false'
  union all select 'audit_logs 可 DELETE（应 false）',
         has_table_privilege('authenticated','public.audit_logs','DELETE')::text, 'false'
  union all select 'daily_metrics.value 可空（应 YES）',
         (select is_nullable from information_schema.columns
           where table_schema='public' and table_name='daily_metrics' and column_name='value')::text, 'YES'
`);

console.log("");
console.log(paint("远程自检", C.bold));
console.log("─".repeat(78));
let pass = 0, fail = 0;
for (const r of checks.rows) {
  const ok = r.actual === r.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? paint("✓", C.green) : paint("≠", C.red)} ${String(r.item).padEnd(30)} 实际 ${String(r.actual).padEnd(8)} 期望 ${r.expect}`);
}
console.log("─".repeat(78));
console.log(`合计 ${checks.rows.length} 项：✓ ${pass} · ≠ ${fail}`);

await client.end();
process.exit(fail === 0 ? 0 : 2);
