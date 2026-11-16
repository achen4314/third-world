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

// 回滚判据：跑之前先记下审计表行数，跑完必须回到同一个数
const auditBefore = (await one("select count(*)::int n from public.audit_logs")).n;

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

  check("两个训练日都有 TL 行", !!byDay[dayA]?.["tl.srpe"] && !!byDay[dayB]?.["tl.srpe"],
    `天数=${Object.keys(byDay).length}`);
  // 0011：状态量逐日推进，休息日有 CTL/ACWR 但没有 TL（不补 0）
  const restDay = "2026-11-06";
  check("休息日状态量逐日推进（CTL 有值）", byDay[restDay]?.ctl !== undefined, `ctl=${byDay[restDay]?.ctl}`);
  check("休息日不写 TL（缺测=无行）", byDay[restDay]?.["tl.srpe"] === undefined,
    `tl=${byDay[restDay]?.["tl.srpe"]}`);
  check("Day1 TL = 100", byDay[dayA]?.["tl.srpe"] === 100, `实际 ${byDay[dayA]?.["tl.srpe"]}`);
  check("Day2 TL = 60（当天单独聚合）", byDay[dayB]?.["tl.srpe"] === 60, `实际 ${byDay[dayB]?.["tl.srpe"]}`);
  // 0014 口径：EWMA 四个状态量从 0 起步，首日 CTL=TL/42、ATL=TL/7。
  const expCtl1 = 100 / 42;
  const expAtl1 = 100 / 7;
  const expCtl2 = expCtl1 + (60 - expCtl1) / 42;
  check("Day1 CTL = TL/42（EWMA 从 0 起步）", Math.abs(byDay[dayA].ctl - expCtl1) < 0.01, `实际 ${byDay[dayA].ctl}`);
  check("Day1 ATL = TL/7（EWMA 从 0 起步）", Math.abs(byDay[dayA].atl - expAtl1) < 0.01, `实际 ${byDay[dayA].atl}`);
  check("Day2 CTL 按 λ=1/42 递推", Math.abs(byDay[dayB].ctl - expCtl2) < 0.05,
    `期望 ${expCtl2.toFixed(4)} 实际 ${byDay[dayB].ctl}`);
  const expAcu1 = 0.25 * 100, expChr1 = 0.069 * 100;
  const expAcu2 = expAcu1 + 0.25 * (60 - expAcu1);
  const expChr2 = expChr1 + 0.069 * (60 - expChr1);
  check("Day2 ACWR(EWMA) 与 2/(7+1)、2/(28+1) 一致",
    Math.abs(byDay[dayB]["acwr.ewma"] - expAcu2 / expChr2) < 0.005,
    `实际 ${byDay[dayB]["acwr.ewma"]} 期望 ${(expAcu2 / expChr2).toFixed(4)}`);
  check("TM/TS 在有效天不足时不给值（不写 0）",
    byDay[dayA].tm === undefined && byDay[dayA].ts === undefined,
    "第 1–6 天无 7/7 有效天");
  check("calc_version 落库", dm.rows.every((r) => r.calc_version === "v1.0"));

  // 0012：休息日按 0 负荷推进 EWMA，不能再「延续」。延续会让连休两周的 ATL
  // 停在停训前，TSB 不回升、就绪度继续说「可执行既定强度」。
  const restCtl = byDay[restDay]?.ctl;
  const restAtl = byDay[restDay]?.atl;
  check("休息日 CTL 按 0 负荷衰减（λ=1/42）",
    restCtl !== undefined && Math.abs(restCtl - byDay[dayB].ctl * (1 - 1 / 42)) < 0.01,
    `实际 ${restCtl} 期望 ${(byDay[dayB].ctl * (1 - 1 / 42)).toFixed(4)}`);
  check("休息日 ATL 按 0 负荷衰减（λ=1/7）",
    restAtl !== undefined && Math.abs(restAtl - byDay[dayB].atl * (1 - 1 / 7)) < 0.01,
    `实际 ${restAtl} 期望 ${(byDay[dayB].atl * (1 - 1 / 7)).toFixed(4)}`);
  check("休息日 ACWR(EWMA) 下降而不是冻结",
    byDay[restDay]["acwr.ewma"] < byDay[dayB]["acwr.ewma"],
    `${byDay[dayB]["acwr.ewma"]} → ${byDay[restDay]["acwr.ewma"]}`);

  // 连休 14 天：ATL 必须降到 20% 以下，且休息日仍不落 tl.srpe
  const longRest = "2026-11-20";
  await asUser(athleteUser.id, () =>
    q(`select public.arc_recompute_metrics($1, $2::date)`, [ath.id, longRest]));
  const tail = await one(
    `select max(case when metric_id='atl' then value end) atl,
            max(case when metric_id='tsb' then value end) tsb,
            max(case when metric_id='tl.srpe' then value end) tl
       from public.daily_metrics where athlete_id=$1 and metric_date=$2::date`,
    [ath.id, longRest]);
  check("连休 14 天 ATL 降到 20% 以下", Number(tail.atl) < Number(byDay[dayB].atl) * 0.2,
    `${byDay[dayB].atl} → ${tail.atl}`);
  check("连休 14 天 TSB 回升为正", Number(tail.tsb) > 0, `tsb=${tail.tsb}`);
  check("连休 14 天仍不写 TL（不补 0）", tail.tl === null, `tl=${tail.tl}`);

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

  /* ── H. 周期计划 / 课库 / 规则版本（0007）────────────────────────────── */
  console.log("\nH. 周期计划 / 课库 / 规则版本");
  const tpl = await asUser(coachUser.id, async () =>
    one(`insert into public.session_templates (org_id, title, purpose, duration_min, intensity_rpe, tags)
         values ($1, '下肢力量 · VBT', 'strength', 68, 7, array['下肢','VBT']) returning id`, [coachOrg]));
  check("教练可建课库模板", !!tpl?.id);

  await asUser(coachUser.id, async () => {
    await q(`insert into public.session_items (template_id, org_id, seq, exercise, sets, reps, pct_1rm, rest_s, vel_min)
             values ($1,$2,1,'深蹲',5,3,80,180,0.5)`, [tpl.id, coachOrg]);
    await q(`insert into public.session_items (template_id, org_id, seq, exercise, sets, reps, load_kg, rest_s)
             values ($1,$2,2,'罗马尼亚硬拉',4,6,100,120)`, [tpl.id, coachOrg]);
  });
  const items = await one(`select count(*)::int n from public.session_items where template_id = $1`, [tpl.id]);
  check("课库条目写入 2 条", items.n === 2, `n=${items.n}`);

  await expectError("绝对重量与 %1RM 不能同时填", async () =>
    asUser(coachUser.id, () =>
      q(`insert into public.session_items (template_id, org_id, seq, exercise, sets, reps, load_kg, pct_1rm)
         values ($1,$2,3,'冲突行',3,5,100,80)`, [tpl.id, coachOrg])), "23514");

  await expectError("运动员不能建课库模板", async () =>
    asUser(athleteUser.id, () =>
      q(`insert into public.session_templates (org_id, title) values ($1, '偷建模板')`, [soloOrg])), "42501");

  const cycle = await asUser(coachUser.id, async () =>
    one(`insert into public.plan_cycles (org_id, athlete_id, name, goal, start_date, end_date, phase, status, created_by)
         values ($1,$2,'冬训基础期','提升起跳功率','2026-11-02','2026-11-29','base','active',$3) returning id`,
      [coachOrg, nath.id, coachUser.id]));
  check("建立周期计划", !!cycle?.id);

  await asUser(coachUser.id, async () =>
    q(`insert into public.plan_blocks (cycle_id, org_id, week_index, start_date, end_date, focus, target_load_min, target_load_max)
       values ($1,$2,1,'2026-11-02','2026-11-08','解剖适应',200,320)`, [cycle.id, coachOrg]));
  const blk = await one(`select count(*)::int n from public.plan_blocks where cycle_id = $1`, [cycle.id]);
  check("周期块按周写入", blk.n === 1, `n=${blk.n}`);

  const asg = await asUser(coachUser.id, async () =>
    one(`select public.arc_assign_session($1,$2,$3::date,'首次课') as id`, [nath.id, tpl.id, "2026-11-06"]));
  check("排课成功", !!asg?.id);

  const week = await asUser(coachUser.id, async () =>
    one(`select count(*)::int n, max(title) t from public.arc_week_plan($1, $2::date)`, [nath.id, "2026-11-06"]));
  check("本周计划能读出排的课", week.n === 1 && week.t === "下肢力量 · VBT", `n=${week.n} t=${week.t}`);

  // 计划 50 AU，实际 45 AU（F 组写入的冲刺课）→ 执行率 0.9；状态改 done 后依从率 1
  await asUser(coachUser.id, async () =>
    q(`update public.session_assignments set planned_load = 50 where id = $1`, [asg.id]));
  const prog1 = await asUser(coachUser.id, async () =>
    one(`select public.arc_cycle_progress($1) as p`, [cycle.id]));
  check("执行度：计划 50 / 实际 45 → 比值 0.9",
    Number(prog1.p.load.ratio) === 0.9, `ratio=${prog1.p.load.ratio} actual=${prog1.p.load.actual}`);
  check("执行度：未完成时依从率 0", Number(prog1.p.assignments.adherence) === 0);

  await asUser(coachUser.id, async () =>
    q(`update public.session_assignments set status = 'done' where id = $1`, [asg.id]));
  const prog2 = await asUser(coachUser.id, async () =>
    one(`select public.arc_cycle_progress($1) as p`, [cycle.id]));
  check("标记完成后依从率 1", Number(prog2.p.assignments.adherence) === 1);

  const ruleId = await asUser(coachUser.id, async () =>
    one(`select public.arc_seed_default_rules($1) as id`, [coachOrg]));
  check("写入默认规则版本 v1.0", !!ruleId?.id);
  const active = await asUser(coachUser.id, async () =>
    one(`select public.arc_active_rule($1) as r`, [coachOrg]));
  check("生效规则含 ACWR 区间阈值",
    active.r?.acwr?.low === 0.8 && active.r?.acwr?.danger === 1.5,
    `low=${active.r?.acwr?.low} danger=${active.r?.acwr?.danger}`);

  await expectError("运动员不能切换规则版本", async () =>
    asUser(athleteUser.id, () => q(`select public.arc_activate_rule($1)`, [ruleId.id])), "42501");

  await expectError("同一组织不能有两个生效规则版本", async () =>
    asUser(coachUser.id, async () => {
      await q(`insert into public.rules (org_id, version, name, payload, is_active) values ($1,'v9.9','并发版本','{}'::jsonb,true)`,
        [coachOrg]);
    }), "23505");

  const outTpl = await asUser(outsider.id, async () =>
    one(`select count(*)::int n from public.session_templates`));
  check("外部账号读不到课库", outTpl.n === 0, `n=${outTpl.n}`);
  const outPlan = await asUser(outsider.id, async () =>
    one(`select count(*)::int n from public.plan_cycles`));
  check("外部账号读不到计划", outPlan.n === 0, `n=${outPlan.n}`);

  /* ── I. 具体计算：跳跃 / VBT / 恢复 / 就绪 ─────────────────────────── */
  console.log("\nI. 具体计算");
  // 体重是 PPO 的输入；没有体重就不该出 PPO（不猜）
  await asUser(athleteUser.id, async () =>
    q(`update public.athletes set weight_kg = 74 where id = $1`, [ath.id]));

  const jsess = await asUser(athleteUser.id, async () =>
    one(`insert into public.test_sessions (org_id, athlete_id, kind, performed_at, source)
         values ($1,$2,'jump','2026-11-06 10:00+08','manual') returning id`, [soloOrg, ath.id]));
  await asUser(athleteUser.id, async () =>
    q(`insert into public.jump_tests (session_id, jump_type, flight_ms, contact_ms)
       values ($1,'cmj',600,500)`, [jsess.id]));

  const jt = await one(`select height_cm, rsi from public.jump_tests where session_id = $1`, [jsess.id]);
  check("跳跃高度由飞行时间自动补算 44.15cm", Number(jt.height_cm) === 44.15, `实际 ${jt.height_cm}`);
  check("RSI 自动补算 0.883", Number(jt.rsi) === 0.883, `实际 ${jt.rsi}`);

  const jumpDay = await q(`select metric_id, value from public.daily_metrics
                            where athlete_id = $1 and metric_date = '2026-11-06'::date and metric_id like 'jump.%'`, [ath.id]);
  const jmap = Object.fromEntries(jumpDay.rows.map((r) => [r.metric_id, Number(r.value)]));
  check("跳跃指标落库（高度/RSI/触地/PPO）",
    jmap["jump.height"] === 44.15 && jmap["jump.rsi"] === 0.883 && jmap["jump.contact_time"] === 500,
    JSON.stringify(jmap));
  check("PPO 用体重算（44.15cm/74kg → 3977.1W）", jmap["jump.ppo"] === 3977.1, `实际 ${jmap["jump.ppo"]}`);

  const vsess = await asUser(athleteUser.id, async () =>
    one(`insert into public.test_sessions (org_id, athlete_id, kind, performed_at, source)
         values ($1,$2,'vbt','2026-11-07 10:00+08','manual') returning id`, [soloOrg, ath.id]));
  const loads = [[60, 0.95], [80, 0.82], [100, 0.70], [120, 0.58]];
  await asUser(athleteUser.id, async () => {
    for (const [ld, mpv] of loads) {
      await q(`insert into public.vbt_sets (session_id, exercise, load_kg, reps, mpv)
               values ($1,'深蹲',$2,3,$3)`, [vsess.id, ld, mpv]);
    }
  });
  const vrows = await q(`select load_kg, mpv, vl_pct, power_w from public.vbt_sets
                          where session_id = $1 order by load_kg`, [vsess.id]);
  check("速度损失以组内最快一次为基准（首组 0%，末组 38.95%）",
    Number(vrows.rows[0].vl_pct) === 0 && Math.abs(Number(vrows.rows[3].vl_pct) - 38.95) < 0.01,
    `首 ${vrows.rows[0].vl_pct} 末 ${vrows.rows[3].vl_pct}`);
  check("功率 = load·g·MPV（100kg × 0.70 = 686.7W）",
    Math.abs(Number(vrows.rows[2].power_w) - 686.7) < 0.1, `实际 ${vrows.rows[2].power_w}`);

  const prof = await asUser(athleteUser.id, async () =>
    one(`select public.arc_vbt_profile($1,'深蹲',0.3) as p`, [vsess.id]));
  check("负荷-速度剖面可外推 1RM", prof.p.ok === true, JSON.stringify(prof.p).slice(0, 90));
  check("外推 1RM 落在合理区间（140–200kg）",
    prof.p.load_1rm > 140 && prof.p.load_1rm < 200, `1RM=${prof.p.load_1rm}`);

  // 恢复：7 天 HRV + 睡眠 → 基准 / SWC / 偏离 / 睡眠债 / 就绪度
  const hrv = [64, 62, 66, 63, 65, 61, 64];
  const tst = [450, 470, 430, 480, 440, 460, 455];
  await asUser(athleteUser.id, async () => {
    for (let i = 0; i < 7; i++) {
      const d = `2026-11-0${1 + i}`;
      await q(`insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, source)
               values ($1,$2,$3::date,'hrv.rmssd',$4,'ms','manual')
               on conflict (athlete_id, metric_date, metric_id) do update set value = excluded.value`,
        [soloOrg, ath.id, d, hrv[i]]);
      await q(`insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, source)
               values ($1,$2,$3::date,'sleep.tst',$4,'min','manual')
               on conflict (athlete_id, metric_date, metric_id) do update set value = excluded.value`,
        [soloOrg, ath.id, d, tst[i]]);
    }
  });

  const rec = await q(`select metric_id, value from public.daily_metrics
                        where athlete_id = $1 and metric_date = '2026-11-07'::date
                          and metric_id in ('hrv.lnrmssd','hrv.baseline','hrv.swc','hrv.z','sleep.debt','readiness')`,
    [ath.id]);
  const rmap = Object.fromEntries(rec.rows.map((r) => [r.metric_id, Number(r.value)]));
  check("lnRMSSD = ln(64) = 4.1589", Math.abs(rmap["hrv.lnrmssd"] - 4.1589) < 0.001, `实际 ${rmap["hrv.lnrmssd"]}`);
  check("7 日 HRV 基准已生成", rmap["hrv.baseline"] > 4 && rmap["hrv.baseline"] < 4.3, `baseline=${rmap["hrv.baseline"]}`);
  check("SWC = 0.5·SD 已生成", rmap["hrv.swc"] > 0 && rmap["hrv.swc"] < 0.2, `swc=${rmap["hrv.swc"]}`);
  check("偏离 z 已生成", typeof rmap["hrv.z"] === "number", `z=${rmap["hrv.z"]}`);
  check("睡眠债 = 7×480 − Σ7日 = 3360 − 3185 = 175min",
    rmap["sleep.debt"] === 175, `debt=${rmap["sleep.debt"]}`);
  check("就绪度已计算（0–100）", rmap["readiness"] > 0 && rmap["readiness"] <= 100, `readiness=${rmap["readiness"]}`);

  // 只有 HRV、没有睡眠的那天：仍给分，但覆盖度 < 1，且明确标注缺测
  const sum = await asUser(athleteUser.id, async () =>
    one(`select public.arc_daily_summary($1, '2026-11-12'::date) as s`, [ath.id]));
  check("当日总览返回结构完整",
    sum.s?.date === "2026-11-12" && sum.s.load && sum.s.recovery && sum.s.readiness, "");
  check("缺测被显式列出（未当作 0）",
    Array.isArray(sum.s.missing) && sum.s.missing.length > 0, sum.s.missing.join(" / "));

  await expectError("外部账号不能看别人的当日总览", async () =>
    asUser(outsider.id, () => q(`select public.arc_daily_summary($1, current_date)`, [nath.id])), "42501");

  /* ── J. 删除 / 导出 / 注销 ─────────────────────────────────────────── */
  console.log("\nJ. 删除、导出、注销");
  const exp = await asUser(athleteUser.id, async () =>
    one(`select public.arc_export_my_data() as e`));
  const expOrgs = exp.e.orgs?.length ?? 0;
  const expActs = exp.e.activities?.length ?? 0;
  check("导出结构自带版本号", exp.e.schema === "arc-export/1");
  check("导出只含自己组织的数据", expOrgs === 1, `orgs=${expOrgs}`);
  check("导出包含训练与指标", expActs >= 2 && exp.e.daily_metrics.length > 0,
    `activities=${expActs} metrics=${exp.e.daily_metrics.length}`);

  // 越权删除要趁记录还在：先拿「别人那条」试，再删自己的
  const forbiddenTarget = await one(`select id from public.activities where athlete_id = $1 and training_load = 100`, [ath.id]);
  await expectError("不能删别人的训练", async () =>
    asUser(outsider.id, () => q(`select public.arc_delete_activity($1)`, [forbiddenTarget.id])), "42501");

  const delTarget = await one(`select id from public.activities where athlete_id = $1 and training_load = 60`, [ath.id]);
  await asUser(athleteUser.id, async () =>
    q(`select public.arc_delete_activity($1)`, [delTarget.id]));
  const afterDel = await one(`select count(*)::int n from public.activities where id = $1`, [delTarget.id]);
  check("训练已删除", afterDel.n === 0);
  const delAudit = await one(`select count(*)::int n from public.audit_logs
                               where action = 'activity.delete' and target_id = $1`, [delTarget.id]);
  check("删除动作留痕", delAudit.n === 1, `n=${delAudit.n}`);

  // 删掉当天唯一一条训练后，那天的 TL 不应残留（缺测就是没行，不是 0）
  const staleTl = await one(`select count(*)::int n from public.daily_metrics
                              where athlete_id = $1 and metric_date = '2026-11-05'::date and metric_id = 'tl.srpe'`, [ath.id]);
  check("删除训练后当日 TL 不残留", staleTl.n === 0, `n=${staleTl.n}`);

  // 注销：新建一个只用个人空间的账号，走真删（auth.users 也被删掉）
  const bye = await mkUser("bye", "要注销的人");
  const byeOrg = (await asUser(bye.id, async () =>
    one(`select public.arc_join_solo('要注销的人') as org`))).org;
  await asUser(bye.id, () =>
    q(`insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, source)
       select $1, a.id, '2026-11-08 09:00+08', '跑步', 1800, 30, 'manual'
       from public.athletes a where a.user_id = $2`, [byeOrg, bye.id]));

  await asUser(bye.id, async () => q(`select public.arc_delete_my_account()`));
  const goneUser = await one(`select count(*)::int n from auth.users where id = $1`, [bye.id]);
  const goneApp = await one(`select count(*)::int n from public.app_users where id = $1`, [bye.id]);
  const goneOrg = await one(`select count(*)::int n from public.orgs where id = $1`, [byeOrg]);
  check("注销后 auth 账号已删除", goneUser.n === 0, `n=${goneUser.n}`);
  check("注销后 app_users 已删除", goneApp.n === 0, `n=${goneApp.n}`);
  check("注销后个人空间已清空（连带训练）", goneOrg.n === 0, `n=${goneOrg.n}`);
  const accAudit = await one(`select count(*)::int n from public.audit_logs where action = 'account.delete'`);
  check("注销留痕（actor 置空但记录仍在）", accAudit.n >= 1, `n=${accAudit.n}`);
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
    const auditDelta = residue.audits - auditBefore;
    console.log(`\n已回滚 · 残留 auth 用户 ${residue.users} / 测试组织 ${residue.orgs} / 审计行净增 ${auditDelta}（应为 0）`);
    if (residue.users !== 0 || residue.orgs !== 0 || auditDelta !== 0) {
      console.log("⚠ 有残留：事务回滚没兜住，需人工查");
      process.exitCode = 1;
    }
  }
}

console.log("─".repeat(72));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
await c.end();
process.exit(fail ? 1 : 0);
