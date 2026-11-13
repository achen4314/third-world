#!/usr/bin/env node
/**
 * 第三世界 · 临时查询器（开发用，不参与部署）
 *
 * 为什么需要：apply-sql.mjs 只打印「脚本末尾自检」那种窄表格，jsonb 一列就被截断，
 * 排查 RPC 返回值时看不见全貌。这个工具直接把结果打成 JSON。
 *
 * 用法：
 *   node tools/q.mjs "select 1 as a"
 *   node tools/q.mjs --as demo@third.world "select public.arc_daily_summary(a.id, null) from public.athletes a"
 *   node tools/q.mjs --file /tmp/x.sql          # 多语句
 *   node tools/q.mjs --as demo@third.world --file /tmp/x.sql
 *
 * --as：以某个已存在账号的身份执行（等价于登录后的 SQL：set role authenticated + jwt claims）
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);

function readEnv() {
  const env = {};
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) throw new Error("缺少 .env.local");
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

let asUser = null;
let sql = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--as") asUser = argv[++i];
  else if (argv[i] === "--file") sql = fs.readFileSync(argv[++i], "utf8");
  else if (!argv[i].startsWith("--")) sql = argv[i];
}
if (!sql) {
  console.error("用法：node tools/q.mjs [--as email] \"<sql>\" | --file <path>");
  process.exit(1);
}

const env = readEnv();
const c = new pg.Client({
  connectionString: env.DIRECT_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await c.connect();

let uid = null;
if (asUser) {
  const r = await c.query("select id from auth.users where lower(email) = lower($1)", [asUser]);
  if (!r.rows[0]) {
    console.error("找不到账号：" + asUser);
    process.exit(1);
  }
  uid = r.rows[0].id;
}

try {
  if (uid) {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  }
  const res = await c.query(sql);
  const out = Array.isArray(res) ? res[res.length - 1] : res;
  console.log(JSON.stringify(out.rows, null, 2));
  if (uid) await c.query("rollback");
} catch (e) {
  console.error("✗", e.code || "", e.message);
  if (uid) { try { await c.query("rollback"); } catch { /* noop */ } }
  process.exitCode = 1;
} finally {
  await c.end();
}
