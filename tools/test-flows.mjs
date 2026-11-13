#!/usr/bin/env node
/**
 * 第三世界 · 业务流程回归测试（真实库，全程事务内，结束回滚）
 *
 * 目的：证明「注册 → 开通 → 记录训练 → 指标自动计算 → 教练看得到 → 别人看不到」
 *       这条链路在真实 Postgres + 真实 RLS 下确实走得通，而不是只有表建好了。
 *
 * 做法：用 postgres 建 auth 用户（等价于 GoTrue 注册），然后 `set local role authenticated`
 *       + 设置 request.jwt.claims 来模拟该用户，逐条调用 RPC / 走 RLS。
 *
 * 用法：node tools/test-flows.mjs            (有失败则退出码 1)
 *       node tools/test-flows.mjs --keep     (不回滚，便于手工排查；慎用)
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KEEP = process.argv.includes("--keep");

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

const env = readEnv();
const url = env.DIRECT_URL || env.DATABASE_URL;
if (!url) throw new Error(".env.local 里没有 DIRECT_URL / DATABASE_URL");

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
await c.connect();

let pass = 0, fail = 0;
const results = [];

function ok(name, detail = "") {
  pass++;
  results.push({ ok: true, name, detail });
  console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, detail = "") {
  fail++;
  results.push({ ok: false, name, detail });
  console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
}
function check(name, cond, detail = "") {
  cond ? ok(name, detail) : bad(name, detail);
}

async function q(sql, params) {
  const r = await c.query(sql, params);
  return r;
}
async function one(sql, params) {
  const r = await c.query(sql, params);
  return r.rows[0];
}
/**
 * 以某用户身份执行一段 SQL。
 * 成功 → release savepoint（改动保留在外层事务里，流程才能串起来）
 * 失败 → rollback 到 savepoint（外层事务仍可用，便于继续断言）
 */
async function asUser(uid, fn) {
  await q("savepoint usr");
  await q("set local role authenticated");
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  try {
    const out = await fn();
    await q("reset role");
    await q("release savepoint usr");
    return out;
  } catch (e) {
    try { await q("reset role"); } catch { /* noop */ }
    try { await q("rollback to savepoint usr"); } catch { /* noop */ }
    throw e;
  }
}
async function asAnon(fn) {
  await q("savepoint usr");
  await q("set local role anon");
  await q("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
  try {
    return await fn();
  } finally {
    try { await q("reset role"); } catch { /* noop */ }
    await q("rollback to savepoint usr");
  }
}
async function expectError(name, fn, codeLike) {
  try {
    await fn();
    bad(name, "应当报错但成功了");
  } catch (e) {
    const hit = !codeLike || String(e.code || "").includes(codeLike) || String(e.message || "").includes(codeLike);
    check(name, hit, `→ ${e.code || ""} ${String(e.message).slice(0, 70)}`);
  }
}

const stamp = Date.now().toString(36);
const mkEmail = (k) => `t_${k}_${stamp}@arc.local`;

async function mkUser(key, name) {
  const email = mkEmail(key);
  const r = await one(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                             created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
             $1, crypt('test1234', gen_salt('bf')), now(), now(), now(),
             '{"provider":"email","providers":["email"]}'::jsonb,
             jsonb_build_object('display_name', $2::text))
     returning id, email`,
    [email, name]
  );
  await q(
    `insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $2::text, 'email',
             jsonb_build_object('sub', $2::text, 'email', $3::text, 'email_verified', true), now(), now(), now())`,
    [r.id, r.id, r.email]
  );
  return r;
}

console.log("\n第三世界 · 业务流程回归（真实库 / 事务内）");
console.log("─".repeat(72));

await q("begin");

try {
  /* ── A. 注册：auth.users → app_users 自动桥接 ───────────────────────── */
  console.log("\nA. 注册桥接（0005）");
  const athleteUser = await mkUser("ath", "测试运动员");
  const coachUser = await mkUser("coach", "测试教练");
  const outsider = await mkUser("out", "外部账号");

  const au = await one("select id, display_name from public.app_users where id = $1", [athleteUser.id]);
  check("注册后自动生成 app_users 行", !!au, au ? `display_name=${au.display_name}` : "");
  check("显示名取自注册元数据", au && au.display_name === "测试运动员");

  /* ── B. 运动员自助开通个人空间 ─────────────────────────────────────── */
  console.log("\nB. 运动员开通（arc_join_solo）");
  const soloOrg = await asUser(athleteUser.id, async () => {
    const r = await one("select public.arc_join_solo($1) as org", ["测试运动员"]);
    return r.org;
  });
  check("返回 org_id", !!soloOrg);

  const mem = await one("select org_id, role from public.memberships where user_id = $1", [athleteUser.id]);
  check("成员关系 = athlete", mem && mem.role === "athlete", mem ? `role=${mem.role}` : "");
  const ath = await one("select id, org_id, full_name, user_id from public.athletes where user_id = $1", [athleteUser.id]);
  check("自动建立自己的运动员档案", !!ath, ath ? `id=${ath.id.slice(0, 8)}` : "");
  check("档案挂在同一组织", ath && ath.org_id === soloOrg);

  await expectError("重复开通被拒", async () =>
    asUser(athleteUser.id, () => q("select public.arc_join_solo($1)", ["再来一次"])), "23505");

  /* ── C. 记录训练 → 服务端自动算指标 ───────────────────────────────── */
  console.log("\nC. 记录训练与指标自动计算（0006）");
  const dayA = "2026-11-04";
  const dayB = "2026-11-05";
  await asUser(athleteUser.id, async () => {
    await q(
      `insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
       values ($1, $2, $3::date + time '09:00', '力量', 3600, 100, 'srpe', 7, 'manual')`,
      [soloOrg, ath.id, dayA]
    );
    await q(
      `insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
       values ($1, $2, $3::date + time '09:30', '跑步', 3000, 60, 'srpe', 6, 'manual')`,
      [soloOrg, ath.id, dayB]
    );
  });

  const dm = await q(
    `select metric_date::text d, metric_id, value, unit, calc_version
       from public.daily_metrics where athlete_id = $1 order by metric_date, metric_id`,
    [ath.id]
  );
  const byDay = {};
  for (const r of dm.rows) (byDay[r.d] = byDay[r.d] || {})[r.metric_id] = Number(r.value);

  check("指标已落库（两天）", Object.keys(byDay).length === 2, `天数=${Object.keys(byDay).length}`);
  check("Day1 TL = 100", byDay[dayA]?.["tl.srpe"] === 100, `实际 ${byDay[dayA]?.["tl.srpe"]}`);
  check("Day2 TL = 60（当天单独聚合）", byDay[dayB]?.["tl.srpe"] === 60, `实际 ${byDay[dayB]?.["tl.srpe"]}`);
  const expCtl1 = 100;
  const expCtl2 = 100 + (60 - 100) / 42;
  check("Day1 CTL = TL", Math.abs(byDay[dayA].ctl - expCtl1) < 0.01, `实际 ${byDay[dayA].ctl}`);
  check("Day2 CTL 按 λ=1/42 递推", Math.abs(byDay[dayB].ctl - expCtl2) < 0.05,
    `期望 ${expCtl2.toFixed(4)} 实际 ${byDay[dayB].ctl}`);
  const expAcu2 = 100 + 0.25 * (60 - 100);
  const expChr2 = 100 + 0.069 * (60 - 100);
  check("Day2 ACWR(EWMA) 与 2/(7+1)、2/(28+1) 一致",
    Math.abs(byDay[dayB]["acwr.ewma"] - expAcu2 / expChr2) < 0.005,
    `实际 ${byDay[dayB]["acwr.ewma"]} 期望 ${(expAcu2 / expChr2).toFixed(4)}`);
  check("TM/TS 在有效天不足时不给值（不写 0）",
    byDay[dayA].tm === undefined && byDay[dayA].ts === undefined,
    "第 1–6 天无 7/7 有效天");
  check("calc_version 落库", dm.rows.every((r) => r.calc_version === "v1.0"));

  /* ── D. 越权与隔离 ─────────────────────────────────────────────────── */
  console.log("\nD. 权限隔离");
  await expectError("他人无法向我的档案写训练", async () =>
    asUser(outsider.id, () =>
      q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, source)
         values ($1,$2,now(),'越权',600,'manual')`, [soloOrg, ath.id])), "42501");

  const outRead = await asUser(outsider.id, async () => one("select count(*)::int n from public.activities"));
  check("外部账号读到 0 行", outRead.n === 0, `n=${outRead.n}`);

  const outAth = await asUser(outsider.id, async () => one("select count(*)::int n from public.athletes"));
  check("外部账号读不到运动员档案", outAth.n === 0, `n=${outAth.n}`);

  // anon 现在连表级 SELECT 权限都没有（0004 已收回），比「RLS 返回 0 行」更硬。
  // 两种结果都算通过：读到 0 行 或 直接 permission denied。
  const anonRead = await asAnon(async () => {
    try {
      const r = await one("select count(*)::int n from public.activities");
      return { n: r.n };
    } catch (e) {
      return { denied: e.code };
    }
  });
  check("anon 读不到任何训练数据", anonRead.denied === "42501" || anonRead.n === 0,
    anonRead.denied ? `表级权限已收回（${anonRead.denied}）` : `n=${anonRead.n}`);

  await expectError("anon 不能调用开通 RPC", async () =>
    asAnon(() => q("select public.arc_join_solo($1)", ["匿名"])), "42501");

  await expectError("客户端不能自写审计日志", async () =>
    asUser(athleteUser.id, () =>
      q(`insert into public.audit_logs (actor_id, action) values ($1, 'fake.action')`, [athleteUser.id])), "42501");

  await expectError("不能替别人重算指标", async () =>
    asUser(outsider.id, () => q("select public.arc_recompute_metrics($1, current_date)", [ath.id])), "42501");

  /* ── E. 数据校验 ───────────────────────────────────────────────────── */
  console.log("\nE. 数据校验（数据库层）");
  await expectError("时长必须 > 0", async () =>
    asUser(athleteUser.id, () =>
      q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, source)
         values ($1,$2,now(),'跑步',-5,'manual')`, [soloOrg, ath.id])), "23514");
  await expectError("RPE 必须 0–10", async () =>
    asUser(athleteUser.id, () =>
      q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, rpe, source)
         values ($1,$2,now(),'跑步',600,11,'manual')`, [soloOrg, ath.id])), "23514");
  await expectError("负荷上限 5000", async () =>
    asUser(athleteUser.id, () =>
      q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, source)
         values ($1,$2,now(),'跑步',600,5001,'manual')`, [soloOrg, ath.id])), "23514");

  /* ── F. 教练：建组织 → 发码 → 运动员兑换 → 教练看得到 ─────────────── */
  console.log("\nF. 教练团队流程");
  const coachOrg = await asUser(coachUser.id, async () => {
    const r = await one("select public.arc_bootstrap_org($1, $2, false) as org", ["测试队", "测试教练"]);
    return r.org;
  });
  check("教练开通组织", !!coachOrg);
  const cm = await one("select role from public.memberships where user_id = $1 and org_id = $2", [coachUser.id, coachOrg]);
  check("本人角色 = org_admin", cm && cm.role === "org_admin", cm ? cm.role : "");

  const inv = await asUser(coachUser.id, async () => {
    const r = await one("select * from public.arc_create_invite('athlete'::text, null, 3, 7)");
    return r;
  });
  check("生成邀请码", !!inv?.code, inv ? `code=${inv.code}` : "");

  const newAthlete = await mkUser("ath2", "被邀请运动员");
  const joined = await asUser(newAthlete.id, async () =>
    one("select public.arc_redeem_invite($1) as org", [inv.code]));
  check("兑换成功", joined.org === coachOrg);

  const nm = await one("select role, team_id from public.memberships where user_id = $1 and org_id = $2",
    [newAthlete.id, coachOrg]);
  check("兑换后角色 = athlete", nm && nm.role === "athlete");
  const nath = await one("select id from public.athletes where user_id = $1 and org_id = $2", [newAthlete.id, coachOrg]);
  check("兑换时自动建档案", !!nath);

  await asUser(newAthlete.id, () =>
    q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, source)
       values ($1,$2,$3::date + time '10:00','冲刺',1800,45,'manual')`, [coachOrg, nath.id, "2026-11-06"]));

  const coachView = await asUser(coachUser.id, async () =>
    one("select count(*)::int n from public.activities where athlete_id = $1", [nath.id]));
  check("教练能看到队员训练", coachView.n === 1, `n=${coachView.n}`);

  const coachMetrics = await asUser(coachUser.id, async () =>
    one("select count(*)::int n from public.daily_metrics where athlete_id = $1", [nath.id]));
  check("教练能看到队员指标", coachMetrics.n > 0, `n=${coachMetrics.n}`);

  await expectError("已用尽的邀请码不能再兑换", async () => {
    // max_uses=3 的码用 1 次，另建一个 1 次码并连用两次来验证计数
    const inv2 = await asUser(coachUser.id, () => one("select * from public.arc_create_invite('observer'::text, null, 1, 7)"));
    const u3 = await mkUser("obs", "观察者");
    await asUser(u3.id, () => q("select public.arc_redeem_invite($1)", [inv2.code]));
    const u4 = await mkUser("obs2", "观察者2");
    await asUser(u4.id, () => q("select public.arc_redeem_invite($1)", [inv2.code]));
  }, "22023");

  await expectError("收回码后无法再兑换", async () => {
    const inv3 = await asUser(coachUser.id, () => one("select * from public.arc_create_invite('athlete'::text, null, 5, 7)"));
    await asUser(coachUser.id, () =>
      q("update public.invites set revoked_at = now() where code = $1", [inv3.code]));
    const u5 = await mkUser("rev", "被撤销");
    await asUser(u5.id, () => q("select public.arc_redeem_invite($1)", [inv3.code]));
  }, "22023");

  await expectError("不能通过邀请码拿到 org_admin", async () =>
    asUser(coachUser.id, () => q("select public.arc_create_invite('org_admin'::text, null, 1, 7)")), "42501");

  /* ── G. 审计真实留痕 ──────────────────────────────────────────────── */
  console.log("\nG. 审计");
  const audit = await asUser(coachUser.id, async () =>
    one(`select count(*)::int n from public.audit_logs where org_id = $1`, [coachOrg]));
  check("组织内可见审计记录", audit.n > 0, `n=${audit.n}`);
  const auditKinds = await q(
    `select action, count(*)::int n from public.audit_logs where org_id = $1 group by 1 order by 1`, [coachOrg]);
  const kinds = auditKinds.rows.map((r) => r.action);
  check("记录了开通 / 发码 / 兑换 / 训练写入",
    ["org.bootstrap", "invite.create", "invite.redeem", "activities.insert"].every((k) => kinds.includes(k)),
    kinds.join(", "));
} finally {
  if (KEEP) {
    await q("commit");
    console.log("\n⚠ --keep：测试数据已提交（未回滚）");
  } else {
    await q("rollback");
    const residue = await one(`select
      (select count(*) from auth.users where email like '%@arc.local')::int users,
      (select count(*) from public.orgs where name in ('测试队'))::int orgs,
      (select count(*) from public.audit_logs)::int audits`);
    console.log(`\n已回滚 · 残留 auth 用户 ${residue.users} / 测试组织 ${residue.orgs} / 审计行 ${residue.audits}`);
  }
}

console.log("─".repeat(72));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
await c.end();
process.exit(fail ? 1 : 0);
