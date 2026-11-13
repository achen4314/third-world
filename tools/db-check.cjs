/* 第三世界 · 迁移与 RLS 实跑验证（可复现）
 * 用法：npm i -D @electric-sql/pglite && node tools/db-check.cjs
 *
 * 用 PGlite（WASM Postgres 18）模拟 Supabase 预置环境：
 *   auth.users / auth.uid() / anon / authenticated / service_role / 默认授权
 * 然后按顺序执行 migrations，插入测试数据，验证 4 条越权用例。
 */
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const ROOT = path.join(__dirname, "..", "supabase");
const results = [];
const ok = (name, detail = "") => results.push(["PASS", name, detail]);
const bad = (name, detail = "") => results.push(["FAIL", name, detail]);

(async () => {
  const db = new PGlite();

  // ── 0. 模拟 Supabase 预置环境 ────────────────────────────────
  try {
    await db.exec(`
      create schema if not exists auth;
      create table auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid
        language sql stable
        as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      grant usage on schema auth   to anon, authenticated, service_role;
      grant select on auth.users   to authenticated;
      grant execute on function auth.uid() to authenticated, anon;
      alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    `);
    ok("harness: Supabase 预置环境");
  } catch (e) {
    bad("harness: Supabase 预置环境", e.message);
  }

  // ── 1. 执行迁移 ──────────────────────────────────────────────
  const files = [
    "migrations/20261114000001_init.sql",
    "migrations/20261114000002_rls.sql",
    "seed.sql",
  ];
  for (const f of files) {
    let sql = fs.readFileSync(path.join(ROOT, f), "utf8");
    // PGlite 不打包 pgcrypto；gen_random_uuid() 在 PG13+ 已内置，去掉扩展依赖即可
    sql = sql.replace(/create extension if not exists pgcrypto;/gi, "");
    try {
      await db.exec(sql);
      ok("迁移执行: " + f);
    } catch (e) {
      bad("迁移执行: " + f, e.message);
      console.log(results.map((r) => r.join(" | ")).join("\n"));
      await db.close();
      process.exit(1);
    }
  }

  // ── 2. 结构断言 ──────────────────────────────────────────────
  const q = (s, p) => db.query(s, p);
  try {
    const t = await q(`select count(*)::int n from information_schema.tables
                       where table_schema='public' and table_type='BASE TABLE'`);
    const want = 18; // 17 张 + partitioned parent 计入 base table
    t.rows[0].n >= 17 ? ok(`表数量 ${t.rows[0].n}（含分区父表）`) : bad(`表数量 ${t.rows[0].n}`, `期望 ≥17`);
  } catch (e) { bad("表数量", e.message); }

  try {
    const r = await q(`select count(*)::int n from pg_policies where schemaname='public'`);
    r.rows[0].n >= 30 ? ok(`RLS 策略 ${r.rows[0].n} 条`) : bad(`RLS 策略 ${r.rows[0].n} 条`, "期望 ≥30");
  } catch (e) { bad("RLS 策略计数", e.message); }

  try {
    const r = await q(`select count(*)::int n from public.metric_registry`);
    r.rows[0].n === 30 ? ok("指标口径 30 条") : bad(`指标口径 ${r.rows[0].n} 条`, "期望 30");
    const v = await q(`select count(*)::int n from public.metric_registry where tier='vendor_aligned'`);
    v.rows[0].n === 8 ? ok("vendor_aligned 8 条（与 core 隔离）") : bad(`vendor_aligned ${v.rows[0].n} 条`);
  } catch (e) { bad("指标口径种子", e.message); }

  // ── 3. 造测试数据（以属主身份，绕过 RLS）────────────────────
  const U = {
    coachA: "11111111-1111-1111-1111-111111111111",
    athleteA: "22222222-2222-2222-2222-222222222222",
    coachB: "33333333-3333-3333-3333-333333333333",
    observerA: "44444444-4444-4444-4444-444444444444",
  };
  const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
  const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
  const TEAM_A1 = "cccccccc-0000-0000-0000-000000000011";
  const TEAM_A2 = "cccccccc-0000-0000-0000-000000000012";
  const ATH_A1 = "dddddddd-0000-0000-0000-000000000021";
  const ATH_A2 = "dddddddd-0000-0000-0000-000000000022";
  const ATH_B1 = "dddddddd-0000-0000-0000-000000000023";
  const DEV_B1 = "eeeeeeee-0000-0000-0000-000000000031";

  try {
    await db.exec(`
      insert into auth.users (id, email) values
        ('${U.coachA}','coachA@x.test'), ('${U.athleteA}','athA@x.test'),
        ('${U.coachB}','coachB@x.test'), ('${U.observerA}','obsA@x.test');
      insert into public.app_users (id, display_name) values
        ('${U.coachA}','教练A'), ('${U.athleteA}','队员A'),
        ('${U.coachB}','教练B'), ('${U.observerA}','观察者A');
      insert into public.orgs (id, name, slug) values
        ('${ORG_A}','组织A','org-a'), ('${ORG_B}','组织B','org-b');
      insert into public.teams (id, org_id, name) values
        ('${TEAM_A1}','${ORG_A}','A1 队'), ('${TEAM_A2}','${ORG_A}','A2 队');
      insert into public.memberships (org_id, user_id, team_id, role) values
        ('${ORG_A}','${U.coachA}','${TEAM_A1}','coach'),
        ('${ORG_A}','${U.observerA}', null, 'observer'),
        ('${ORG_B}','${U.coachB}', null, 'org_admin');
      insert into public.athletes (id, org_id, team_id, user_id, full_name) values
        ('${ATH_A1}','${ORG_A}','${TEAM_A1}','${U.athleteA}','运动员A1'),
        ('${ATH_A2}','${ORG_A}','${TEAM_A2}', null, '运动员A2'),
        ('${ATH_B1}','${ORG_B}', null, null, '运动员B1');
      insert into public.devices (id, org_id, athlete_id, kind, serial) values
        ('${DEV_B1}','${ORG_B}','${ATH_B1}','vbt_imu','SN-B1');
      insert into public.device_credentials (device_id, provider, access_token_cipher) values
        ('${DEV_B1}','garmin','\\x00'::bytea);
      insert into public.activities (org_id, athlete_id, started_at, sport, training_load, source, external_id) values
        ('${ORG_A}','${ATH_A1}', now() - interval '1 day','run', 62, 'device','g-1'),
        ('${ORG_B}','${ATH_B1}', now() - interval '1 day','run', 71, 'device','g-2');
      insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, quality) values
        ('${ORG_A}','${ATH_A1}', current_date - 1, 'ctl', 58.2, 'ok'),
        ('${ORG_A}','${ATH_A1}', current_date, 'acwr.ewma', null, 'missing');
    `);
    ok("测试数据写入（2 组织 / 2 队 / 3 运动员）");
  } catch (e) {
    bad("测试数据写入", e.message);
  }

  // ── 4. 越权用例 ──────────────────────────────────────────────
  async function asUser(uid, role, fn) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','${uid}',false); set role ${role};`);
    try { return await fn(); } finally { await db.exec(`reset role;`); }
  }
  async function expectReject(label, uid, role, sql) {
    try {
      await asUser(uid, role, () => db.exec(sql));
      bad(label, "未拦截（应为 RLS 拒绝）");
    } catch (e) {
      /row-level security|permission denied/i.test(e.message)
        ? ok(label, e.message.split("\n")[0].slice(0, 90))
        : bad(label, "非预期错误: " + e.message.slice(0, 90));
    }
  }

  // 用例 1：跨组织不可见
  try {
    const r = await asUser(U.coachA, "authenticated", () =>
      db.query(`select full_name from public.athletes order by full_name`));
    const names = r.rows.map((x) => x.full_name);
    // 正确期望：A1 队教练只有 team 级授权 → 只应看到本队 1 人（A2 在另一队，B1 在另一组织）
    names.length === 1 && names[0] === "运动员A1"
      ? ok("用例1 跨组织+跨队隔离", `仅可见 ${names.join(",")}（A2/B1 均被隔离）`)
      : bad("用例1 跨组织+跨队隔离", `可见 ${JSON.stringify(names)}`);
  } catch (e) { bad("用例1 跨组织不可见", e.message); }

  // 用例 1b：同组织不同队也不可见（team 级授权）
  try {
    const r = await asUser(U.coachA, "authenticated", () =>
      db.query(`select full_name from public.athletes where full_name='运动员A2'`));
    r.rows.length === 0
      ? ok("用例1b 跨队不可见", "A2 队运动员对 A1 队教练不可见")
      : bad("用例1b 跨队不可见", `泄漏 ${r.rows.length} 行`);
  } catch (e) { bad("用例1b 跨队不可见", e.message); }

  // 用例 2：跨组织写入被拒
  await expectReject(
    "用例2 跨组织写入被拒", U.coachA, "authenticated",
    `insert into public.activities (org_id, athlete_id, started_at, sport)
     values ('${ORG_B}','${ATH_B1}', now(), 'run')`
  );

  // 用例 3：observer 写入被拒
  await expectReject(
    "用例3 observer 写入被拒", U.observerA, "authenticated",
    `insert into public.activities (org_id, athlete_id, started_at, sport)
     values ('${ORG_A}','${ATH_A1}', now(), 'run')`
  );

  // 用例 4：device_credentials 默认拒绝
  try {
    const r = await asUser(U.coachB, "authenticated", () =>
      db.query(`select count(*)::int n from public.device_credentials`));
    r.rows[0].n === 0
      ? ok("用例4 令牌表默认拒绝", "即便 org_admin 也只读到 0 行")
      : bad("用例4 令牌表默认拒绝", `泄漏 ${r.rows[0].n} 行`);
  } catch (e) { bad("用例4 令牌表默认拒绝", e.message); }

  // 补充：本人可读自己
  try {
    const r = await asUser(U.athleteA, "authenticated", () =>
      db.query(`select full_name from public.athletes`));
    r.rows.length === 1 && r.rows[0].full_name === "运动员A1"
      ? ok("补充 本人自读", "运动员只看到自己")
      : bad("补充 本人自读", JSON.stringify(r.rows));
  } catch (e) { bad("补充 本人自读", e.message); }

  // 补充：缺测不补 0（value 为 NULL 且 quality=missing 可入库）
  try {
    const r = await asUser(U.coachA, "authenticated", () =>
      db.query(`select value, quality from public.daily_metrics where metric_id='acwr.ewma'`));
    r.rows[0] && r.rows[0].value === null && r.rows[0].quality === "missing"
      ? ok("补充 缺测以 NULL 存储", "未补 0，符合不估算原则")
      : bad("补充 缺测以 NULL 存储", JSON.stringify(r.rows));
  } catch (e) { bad("补充 缺测以 NULL 存储", e.message); }

  // 补充：audit_logs 只追加
  await expectReject("补充 audit_logs 禁改", U.coachA, "authenticated",
    `update public.audit_logs set action='x'`);

  // 补充：分区表可写入
  try {
    await db.exec(`insert into public.raw_samples (athlete_id, channel, ts, value)
                   values ('${ATH_A1}','hr', now(), 142)`);
    const r = await q(`select count(*)::int n from public.raw_samples`);
    r.rows[0].n === 1 ? ok("补充 分区表写入", "raw_samples 默认分区可写") : bad("补充 分区表写入");
  } catch (e) { bad("补充 分区表写入", e.message); }

  // ── 输出 ────────────────────────────────────────────────────
  const pass = results.filter((r) => r[0] === "PASS").length;
  const fail = results.filter((r) => r[0] === "FAIL").length;
  console.log(results.map((r) => `${r[0]}  ${r[1]}${r[2] ? "  — " + r[2] : ""}`).join("\n"));
  console.log(`\n合计 ${results.length} 项：PASS ${pass} / FAIL ${fail}`);
  await db.close();
  process.exit(fail ? 1 : 0);
})();
