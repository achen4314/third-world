#!/usr/bin/env node
/* 第三世界 · 通用 SQL 执行器（增量迁移 / 单次脚本）
 *
 * 用法：
 *   node tools/apply-sql.mjs supabase/migrations/20261114000003_storage_realtime.sql
 *   node tools/apply-sql.mjs <file> --dry-run     # 只检查连接串与文件，不连库
 *   node tools/apply-sql.mjs <file> --check-sql "select 1"   # 执行后再跑一条独立校验
 *
 * 与 apply-remote.mjs 的分工：
 *   apply-remote.mjs  只跑 apply-all.sql（空库一次性建库，非幂等）
 *   apply-sql.mjs     跑任意增量脚本（要求脚本自身幂等），用于 0003 及之后的迁移
 *
 * 安全：
 *   · 绝不打印密码。
 *   · 脚本若未自带 begin/commit，本器会用「单事务 + 失败回滚」包住。
 *   · 执行完把结果集中最后一张有列的表格（即脚本末尾自检）打印出来。
 *
 * 依赖：pg
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry-run");
const checkIdx = args.indexOf("--check-sql");
const CHECK_SQL = checkIdx >= 0 ? args[checkIdx + 1] : null;

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
const paint = (s, c) => (process.stdout.isTTY ? c + s + C.reset : s);

if (!fileArg) {
  console.error(paint("✗ 缺少 SQL 文件路径。", C.red));
  console.error("  用法：node tools/apply-sql.mjs supabase/migrations/20261114000003_storage_realtime.sql");
  process.exit(1);
}
const SQL_FILE = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
if (!fs.existsSync(SQL_FILE)) {
  console.error(paint(`✗ 文件不存在：${SQL_FILE}`, C.red));
  process.exit(1);
}

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
if (!url) {
  console.error(paint("✗ 未找到连接串（DATABASE_URL / DIRECT_URL）。", C.red));
  process.exit(1);
}

let u;
try { u = new URL(url); } catch {
  console.error(paint("✗ 连接串不是合法 URI", C.red)); process.exit(1);
}
const port = u.port || "5432";
const sql = fs.readFileSync(SQL_FILE, "utf8");
const wrapped = /^\s*begin\s*;/i.test(sql);

console.log("");
console.log(paint(`第三世界 · 执行 ${path.relative(ROOT, SQL_FILE)}`, C.bold));
console.log("─".repeat(78));
console.log(`目标   ${u.hostname}:${port}${/pooler\.supabase\.com$/.test(u.hostname) ? paint("  (Supavisor 会话池)", C.dim) : paint("  (直连)", C.dim)}`);
console.log(`用户   ${decodeURIComponent(u.username)}   密码 ${"*".repeat(8)}${paint(" (已读取，不显示)", C.dim)}`);
console.log(`行数   ${sql.split("\n").length}    自带事务 ${wrapped ? "是" : "否（本器会包一层）"}`);

if (DRY) {
  console.log(paint("--dry-run：只检查，不连库。", C.dim));
  process.exit(port === "6543" ? 1 : 0);
}
if (port === "6543") {
  console.error(paint("✗ 6543 是事务池化，不适合 DDL。请用 Session pooler（5432）。", C.red));
  process.exit(1);
}
console.log("─".repeat(78));

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  statement_timeout: 180000,
});

try {
  await client.connect();
  console.log(paint("✓ 连接成功", C.green));
} catch (e) {
  console.error(paint("✗ 连接失败：" + e.message, C.red));
  if (/password|authentication/i.test(e.message)) {
    console.error(paint("  → 密码不对：Dashboard → Settings → Database → Reset database password。", C.yellow));
  } else if (/ENOTFOUND|getaddrinfo/.test(e.message)) {
    console.error(paint("  → 解析失败：直连域名仅 IPv6，改用 aws-1-<region>.pooler.supabase.com 会话池。", C.yellow));
  }
  process.exit(1);
}

const t0 = Date.now();
try {
  const res = await client.query(wrapped ? sql : `begin;\n${sql}\ncommit;`);
  console.log(paint(`✓ 执行成功（${Date.now() - t0} ms）`, C.green));

  // 结果集是数组；倒序找最后一张「有列」的表（即脚本末尾自检）
  const out = Array.isArray(res) ? res : [res];
  const last = [...out].reverse().find((r) => r && r.fields && r.fields.length > 0 && r.rows.length > 0);
  if (last) {
    console.log("");
    console.log(paint("脚本末尾自检", C.bold));
    console.log("─".repeat(78));
    const cols = last.fields.map((f) => f.name);
    for (const row of last.rows) {
      const cells = cols.map((c) => String(row[c] ?? ""));
      const status = cells[cells.length - 1];
      const ok = status === "✓";
      const head = cells.slice(0, -1);
      console.log(`${ok ? paint("✓", C.green) : paint("≠", C.red)} ${head[0].padEnd(34)} ${head.slice(1).map((v) => v.padEnd(8)).join("")}`);
    }
  }
} catch (e) {
  console.error(paint(`✗ 执行失败：${e.code || ""} ${e.message}`, C.red));
  if (e.position) console.error(paint(`  SQL 位置 ${e.position}（第 ${sql.slice(0, Number(e.position)).split("\n").length} 行附近）`, C.dim));
  console.error(paint("  已回滚，库应保持执行前状态。", C.dim));
  await client.end();
  process.exit(1);
}

if (CHECK_SQL) {
  const r = await client.query(CHECK_SQL);
  console.log("");
  console.log(paint("独立校验", C.bold));
  console.table(r.rows);
}

await client.end();
process.exit(0);
