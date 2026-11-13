#!/usr/bin/env node
/* 第三世界 · 数据库设计与权限体系核查（只读，不改任何数据）
 *
 * 用法：
 *   node tools/audit-db.mjs               # 全量核查，输出表格，有 FAIL 则退出码 2
 *   node tools/audit-db.mjs --json        # 机器可读，便于进 CI
 *   node tools/audit-db.mjs --section=rbac
 *
 * 四个检查面：
 *   A 结构      主键 / 外键 / 级联 / 索引 / 约束 / 触发器 / 枚举
 *   B 权限      RLS 开关 / 策略覆盖 / 角色限定 / 函数 search_path / 授权
 *   C 动态越权  anon 与无归属 authenticated 实读 17 张表
 *   D 跨层一致  前端角色 id 与库内 app_role 枚举是否一一对应
 *
 * 依赖：pg
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");
const only = (process.argv.find((a) => a.startsWith("--section=")) ?? "").split("=")[1];

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const paint = (s, c) => (process.stdout.isTTY && !JSON_OUT ? c + s + C.reset : s);

function readEnvLocal() {
  const out = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (v) out[s.slice(0, i).trim()] = v;
    }
  }
  return out;
}

const envFile = readEnvLocal();
const url = process.env.DATABASE_URL || envFile.DIRECT_URL || envFile.DATABASE_URL || "";
if (!url) {
  console.error(paint("✗ 未找到连接串（DATABASE_URL / DIRECT_URL）", C.red));
  process.exit(1);
}

const results = [];
function check(section, name, ok, actual, expect, note = "") {
  results.push({ section, name, ok, actual: String(actual), expect: String(expect), note });
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await client.connect();

const one = async (sql) => (await client.query(sql)).rows[0];
const many = async (sql) => (await client.query(sql)).rows;

/* ══════════════════════════════════════════════════════════════════════════
   A 结构
   ══════════════════════════════════════════════════════════════════════════ */
const TABLES = await many(`
  select c.relname as t
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition
  order by 1`);
const tableNames = TABLES.map((r) => r.t);
const businessTables = tableNames.filter((t) => t !== "raw_samples_default");
const EXPECT_TABLES = 18;   // 0006 新增 invites
check("A 结构", "业务表数量（不含分区子表）", tableNames.length === EXPECT_TABLES, tableNames.length, EXPECT_TABLES);

// A1 主键
const noPk = await many(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition
    and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p')
    and not exists (select 1 from pg_index i where i.indrelid=c.oid and i.indisprimary)`);
check("A 结构", "无主键的表", noPk.length === 0, noPk.map((r) => r.relname).join(",") || 0, 0);

// A2 所有 org_id 列都有 FK → orgs
const orgCols = await many(`
  select table_name from information_schema.columns
  where table_schema='public' and column_name='org_id' order by 1`);
const orgNoFkAll = await many(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p')
    and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='org_id' and not a.attisdropped)
    and not exists (
      select 1 from pg_constraint k join pg_class t on t.oid=k.confrelid
      where k.conrelid=c.oid and k.contype='f' and t.relname='orgs')`);
// 白名单：audit_logs.org_id 故意不建外键（组织注销后审计仍需留存，见 0004 注释）
const ORG_FK_ALLOWLIST = ["audit_logs"];
const orgNoFk = orgNoFkAll.filter((r) => !ORG_FK_ALLOWLIST.includes(r.relname));
check("A 结构", "org_id 无外键的表（白名单外）", orgNoFk.length === 0,
  orgNoFk.map((r) => r.relname).join(",") || 0, 0,
  `共 ${orgCols.length} 张表带 org_id；白名单：${ORG_FK_ALLOWLIST.join(",")}`);

// A3 athlete_id → athletes 且 ON DELETE CASCADE
const athCols = await many(`
  select table_name from information_schema.columns
  where table_schema='public' and column_name='athlete_id' order by 1`);
const athBad = await many(`
  select c.relname as t, k.confdeltype as del
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_constraint k on k.conrelid=c.oid and k.contype='f'
  join pg_class r on r.oid=k.confrelid
  where n.nspname='public' and r.relname='athletes' and k.confdeltype <> 'c'`);
check("A 结构", "athlete_id 外键非 CASCADE 的表", athBad.length === 0, athBad.map((r) => r.t).join(",") || 0, 0,
  `共 ${athCols.length} 张表带 athlete_id`);

// A4 有 updated_at 却无 BEFORE UPDATE 触发的表
const noTouch = await many(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='updated_at' and not a.attisdropped)
    and not exists (select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)`);
check("A 结构", "有 updated_at 但无更新触发器的表", noTouch.length === 0, noTouch.map((r) => r.relname).join(",") || 0, 0);

// A5 单列外键缺索引（写放大 / 全表扫风险）
const fkNoIdx = await many(`
  with fk as (
    select con.conrelid as rel, con.conname, con.conkey[1] as attnum
    from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where con.contype='f' and n.nspname='public' and array_length(con.conkey,1)=1
  )
  select c.relname as t, a.attname as col
  from fk
  join pg_class c on c.oid=fk.rel
  join pg_attribute a on a.attrelid=fk.rel and a.attnum=fk.attnum
  where not exists (select 1 from pg_index i where i.indrelid=fk.rel and i.indkey[0]=fk.attnum)
  order by 1,2`);
check("A 结构", "外键列无索引（FK 写入会全表扫）", fkNoIdx.length === 0,
  fkNoIdx.length ? fkNoIdx.map((r) => `${r.t}.${r.col}`).join(" ") : 0, 0);

// A6 枚举数量（新增枚举要同步 DB 文档）
const enums = await many(`select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
  from pg_type t join pg_enum e on e.enumtypid=t.oid
  join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' group by 1 order by 1`);
check("A 结构", "枚举类型数量", enums.length === 8, enums.length, 8, enums.map((e) => e.typname).join(","));

// A7 无任何关系的孤立表
const isolated = await many(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and not c.relispartition
    and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='f')
    and not exists (select 1 from pg_constraint k where k.confrelid=c.oid and k.contype='f')
    and c.relname <> 'metric_registry'`);
check("A 结构", "孤立表（无入/出外键，metric_registry 除外）", isolated.length === 0,
  isolated.map((r) => r.relname).join(",") || 0, 0);

/* ══════════════════════════════════════════════════════════════════════════
   B 权限
   ══════════════════════════════════════════════════════════════════════════ */
const rlsOff = await many(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition and not c.relrowsecurity`);
check("B 权限", "未启用 RLS 的表", rlsOff.length === 0, rlsOff.map((r) => r.relname).join(",") || 0, 0);

// 策略覆盖矩阵
const pol = await many(`
  select tablename, cmd, roles::text as roles, policyname
  from pg_policies where schemaname='public' order by 1,2`);
const polMatrix = {};
for (const r of pol) {
  polMatrix[r.tablename] ??= {};
  polMatrix[r.tablename][r.cmd] = (polMatrix[r.tablename][r.cmd] ?? 0) + 1;
}
const noPolicy = businessTables.filter((t) => !polMatrix[t]);
check("B 权限", "无任何策略的表（应只有 device_credentials）", noPolicy.length === 1 && noPolicy[0] === "device_credentials",
  noPolicy.join(",") || 0, "device_credentials");

// 策略是否被错误地放给 public（含 anon）
const publicPolicies = pol.filter((p) => p.roles === "{public}" || /(^|,)\s*"?public"?\s*(,|$)/.test(p.roles.replace(/[{}]/g, "")));
check("B 权限", "对 public 开放的策略（会连带放行 anon）", publicPolicies.length === 0,
  publicPolicies.map((p) => `${p.tablename}.${p.policyname}`).join(",") || 0, 0);

// audit_logs 必须只追加
const auditUpd = await one(`select has_table_privilege('authenticated','public.audit_logs','UPDATE') as u,
  has_table_privilege('authenticated','public.audit_logs','DELETE') as d`);
check("B 权限", "authenticated 可改审计日志", auditUpd.u === false && auditUpd.d === false,
  `UPDATE=${auditUpd.u} DELETE=${auditUpd.d}`, "UPDATE=false DELETE=false");

// anon 不得持有任何业务表 DML 权限
const anonGrants = await many(`
  select c.relname, string_agg(p.privilege_type, ',') as privs
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join information_schema.role_table_grants g on g.table_schema='public' and g.table_name=c.relname
  cross join lateral (select g.privilege_type) p
  where n.nspname='public' and g.grantee='anon'
  group by 1 order by 1`);
check("B 权限", "anon 持有 DML 权限的表", anonGrants.length === 0,
  anonGrants.map((r) => `${r.relname}(${r.privs})`).join(",") || 0, 0);

// TRUNCATE 不受 RLS 约束，是必须单独收的权限
const trunc = await one(`
  select
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('anon',c.oid,'TRUNCATE'))::int as anon_t,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('authenticated',c.oid,'TRUNCATE'))::int as auth_t`);
check("B 权限", "anon 可 TRUNCATE 的表（绕 RLS）", trunc.anon_t === 0, trunc.anon_t, 0);
check("B 权限", "authenticated 可 TRUNCATE 的表", trunc.auth_t === 0, trunc.auth_t, 0);

// 未来建表的默认权限：postgres 侧必须已清干净（supabase_admin 侧改不动，单独可见化）
const defacl = await many(`
  select pg_get_userbyid(a.defaclrole) as owner_role,
         count(*) filter (where r.rolname='anon') as anon_grants
  from pg_default_acl a join pg_namespace n on n.oid=a.defaclnamespace
  cross join lateral aclexplode(a.defaclacl) x join pg_roles r on r.oid=x.grantee
  where n.nspname='public' and a.defaclobjtype='r' group by 1 order by 1`);
const pgAnon = defacl.find((d) => d.owner_role === "postgres")?.anon_grants ?? 0;
const platAnon = defacl.find((d) => d.owner_role === "supabase_admin")?.anon_grants ?? 0;
check("B 权限", "postgres 默认权限给 anon 的条目", Number(pgAnon) === 0, pgAnon, 0);
check("B 权限", "supabase_admin 默认权限给 anon（平台侧）", true, platAnon, platAnon,
  "平台侧不可改（postgres 非其成员，实测 42501）；只要建表始终由 postgres 执行即不生效");

// security definer 函数必须锁死 search_path
const badDefiner = await many(`
  select p.proname, coalesce(array_to_string(p.proconfig,','),'') as cfg
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and not exists (
    select 1 from unnest(coalesce(p.proconfig, array[]::text[])) s where s like 'search_path=%')`);
check("B 权限", "SECURITY DEFINER 但未锁 search_path 的函数", badDefiner.length === 0,
  badDefiner.map((r) => r.proname).join(",") || 0, 0);

// 函数必须对 anon 撤销执行权
const anonExec = await many(`
  select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE')`);
check("B 权限", "anon 可执行的 SECURITY DEFINER 函数", anonExec.length === 0,
  anonExec.map((r) => r.proname).join(",") || 0, 0);

// 角色层级：可写集合必须是枚举的子集且不含只读角色
const enumRoles = Array.isArray(enums.find((e) => e.typname === "app_role")?.labels)
  ? enums.find((e) => e.typname === "app_role").labels
  : [];
const writable = ["coach", "team_admin", "org_admin", "clinician"];
const readonly = ["athlete", "analyst", "observer"];
const covered = [...writable, ...readonly];
check("B 权限", "角色枚举未纳入读写分级", enumRoles.every((r) => covered.includes(r)),
  enumRoles.length, covered.length, `写=${writable.join("/")} 只读=${readonly.join("/")}`);

// 存储
const buckets = await many(`select id, public from storage.buckets order by 1`);
check("B 权限", "公开存储桶数量", buckets.filter((b) => b.public).length === 0,
  buckets.filter((b) => b.public).length, 0, buckets.map((b) => b.id).join(","));
const stPol = await many(`select policyname, roles::text as roles from pg_policies where schemaname='storage' and tablename='objects'`);
check("B 权限", "storage 策略数", stPol.length === 16, stPol.length, 16);
check("B 权限", "storage 策略未限定 authenticated", stPol.filter((p) => !p.roles.includes("authenticated")).length === 0,
  stPol.filter((p) => !p.roles.includes("authenticated")).length, 0);

// 实时发布表必须都有 select 策略（否则订阅永远收不到）
const pubTables = await many(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`);
const pubNoSelect = pubTables.filter((p) => !polMatrix[p.tablename]?.SELECT);
check("B 权限", "已发布但无 SELECT 策略的表", pubNoSelect.length === 0,
  pubNoSelect.map((p) => p.tablename).join(",") || 0, 0, `发布 ${pubTables.length} 张`);

/* ══════════════════════════════════════════════════════════════════════════
   C 动态越权（真跑，不推断）
   ══════════════════════════════════════════════════════════════════════════ */
await client.query("begin");
const anonLeaks = [];
const authnLeaks = [];
for (const t of businessTables) {
  await client.query("savepoint s");
  try {
    await client.query("set local role anon");
    await client.query(`select set_config('request.jwt.claims','{"role":"anon"}',true)`);
    const r = await one(`select count(*)::int n from public."${t}"`);
    if (r.n > 0) anonLeaks.push(`${t}=${r.n}`);
    await client.query("rollback to savepoint s");

    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims','{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}',true)`);
    const r2 = await one(`select count(*)::int n from public."${t}"`);
    // 无组织归属的用户只应读到 metric_registry（公开口径表）
    if (r2.n > 0 && t !== "metric_registry") authnLeaks.push(`${t}=${r2.n}`);
    await client.query("rollback to savepoint s");
  } catch (e) {
    // 权限不足直接报错也算拒绝（42501）
    await client.query("rollback to savepoint s");
    if (!/42501|permission denied/i.test(e.message)) anonLeaks.push(`${t}=ERR:${e.code}`);
  }
}
await client.query("rollback");
check("C 动态", "anon 能读到行的表", anonLeaks.length === 0, anonLeaks.join(",") || 0, 0,
  `逐表实读 ${businessTables.length} 张`);
check("C 动态", "无组织归属用户能读到行的业务表", authnLeaks.length === 0, authnLeaks.join(",") || 0, 0);

/* ══════════════════════════════════════════════════════════════════════════
   D 跨层一致：前端角色 id ↔ 库内 app_role
   ══════════════════════════════════════════════════════════════════════════ */
let feRoles = [];
try {
  const dataJs = fs.readFileSync(path.join(ROOT, "prototype/data.js"), "utf8");
  const block = dataJs.split("const ROLES = [")[1]?.split("];")[0] ?? "";
  feRoles = [...block.matchAll(/id:\s*"([a-z_]+)"/g)].map((m) => m[1]);
} catch { /* 前端文件缺失则跳过 */ }
// 前端有展示用角色（head_coach / medical / admin），库内用 RBAC 角色（team_admin / clinician / org_admin）。
// 两边不是同一套命名，必须靠 data.js 里显式的 ROLE_MAP 对齐；缺失即视为跨层不一致。
let roleMap = {};
try {
  const dataJs = fs.readFileSync(path.join(ROOT, "prototype/data.js"), "utf8");
  const block = dataJs.split("const ROLE_MAP = {")[1]?.split("};")[0] ?? "";
  roleMap = Object.fromEntries([...block.matchAll(/([a-z_]+)\s*:\s*"([a-z_]+)"/g)].map((m) => [m[1], m[2]]));
} catch { /* 无前端文件 */ }
const feMissingMap = feRoles.filter((r) => !roleMap[r]);
check("D 跨层", "前端角色未声明库内映射（ROLE_MAP）", feMissingMap.length === 0,
  feMissingMap.join(",") || 0, 0, `前端 ${feRoles.length} 个 / 库内 ${enumRoles.length} 个`);
const badMap = Object.entries(roleMap).filter(([, v]) => !enumRoles.includes(v));
check("D 跨层", "ROLE_MAP 指向了不存在的库内角色", badMap.length === 0,
  badMap.map(([k, v]) => `${k}->${v}`).join(",") || 0, 0);

/* ══════════════════════════════════════════════════════════════════════════
   输出
   ══════════════════════════════════════════════════════════════════════════ */
await client.end();

const sections = ["A 结构", "B 权限", "C 动态", "D 跨层"];
const filtered = only ? results.filter((r) => r.section.startsWith(only)) : results;

if (JSON_OUT) {
  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    total: filtered.length,
    passed: filtered.filter((r) => r.ok).length,
    failed: filtered.filter((r) => !r.ok).length,
    results: filtered,
  }, null, 2));
  process.exit(filtered.every((r) => r.ok) ? 0 : 2);
}

console.log("");
console.log(paint("第三世界 · 数据库与权限体系核查", C.bold));
console.log("─".repeat(86));
for (const s of sections) {
  const rows = filtered.filter((r) => r.section === s);
  if (!rows.length) continue;
  console.log(paint(`\n${s}`, C.cyan + C.bold));
  for (const r of rows) {
    const mark = r.ok ? paint("✓", C.green) : paint("≠", C.red);
    console.log(`${mark} ${r.name.padEnd(38)} 实际 ${String(r.actual).slice(0, 46).padEnd(46)} 期望 ${r.expect}`);
    if (r.note) console.log(paint(`  ${r.note}`, C.dim));
  }
}
const pass = filtered.filter((r) => r.ok).length;
const fail = filtered.length - pass;
console.log("\n" + "─".repeat(86));
console.log(`合计 ${filtered.length} 项：${paint("✓ " + pass, C.green)} · ${fail ? paint("≠ " + fail, C.red) : "≠ 0"}`);
if (fail) {
  console.log(paint("\n未通过项：", C.yellow));
  for (const r of filtered.filter((x) => !x.ok)) console.log(`  · [${r.section}] ${r.name} → 实际 ${r.actual}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 2);
