#!/usr/bin/env node
/**
 * 第三世界 · 演示数据（只给演示账号灌，不动真实用户数据）
 *
 * 用途：让对方登录后立刻看到「有数据的样子」，而不是一片空状态。
 * 边界：只写 demo@third.world 这个账号所属组织的数据；数值是刻意构造的样例，
 *       页面顶部会显示「真实数据」、但这批行来自演示账号，不能当真实训练结论使用。
 *
 * 用法：node tools/seed-demo.mjs [--email demo@third.world] [--days 14] [--reset]
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    opt[k] = v;
  }
}
const EMAIL = opt.email || "demo@third.world";
const DAYS = Number(opt.days || 14);

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = readEnv();
const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const one = async (sql, p) => (await c.query(sql, p)).rows[0];

const me = await one(
  `select u.id, m.org_id, ath.id as athlete_id, ath.full_name
     from auth.users u
     join public.app_users a on a.id = u.id
     join public.memberships m on m.user_id = u.id
     left join public.athletes ath on ath.user_id = u.id and ath.org_id = m.org_id
    where lower(u.email) = $1 limit 1`,
  [EMAIL.toLowerCase()]
);
if (!me) throw new Error("找不到账号或组织：" + EMAIL);
if (!me.athlete_id) throw new Error("该账号还没有运动员档案，先 tools/accounts.mjs create --athlete true");

await c.query("begin");
try {
  if (opt.reset === "true") {
    await c.query("delete from public.activities where athlete_id = $1", [me.athlete_id]);
    await c.query("delete from public.daily_metrics where athlete_id = $1", [me.athlete_id]);
    console.log("已清空旧演示记录");
  }

  // 构造一个有节奏的两周：练 2–3 天、休 1 天，负荷逐步上扬
  const plan = [
    { d: 13, sport: "力量", min: 68, rpe: 7 },
    { d: 12, sport: "跑步", min: 52, rpe: 5 },
    { d: 11, sport: "骑行", min: 81, rpe: 8 },
    { d: 9, sport: "测试", min: 35, rpe: 4 },
    { d: 8, sport: "跑步", min: 104, rpe: 6 },
    { d: 7, sport: "力量", min: 55, rpe: 6 },
    { d: 5, sport: "跑步", min: 46, rpe: 5 },
    { d: 4, sport: "力量", min: 72, rpe: 8 },
    { d: 3, sport: "骑行", min: 60, rpe: 6 },
    { d: 2, sport: "跑步", min: 38, rpe: 4 },
    { d: 1, sport: "力量", min: 64, rpe: 7 }
  ].filter((x) => x.d <= DAYS);

  let n = 0;
  for (const x of plan) {
    const exists = await one(
      `select 1 from public.activities
        where athlete_id = $1
          and (started_at at time zone 'Asia/Shanghai')::date = ((now() at time zone 'Asia/Shanghai')::date - $2::int)`,
      [me.athlete_id, x.d]
    );
    if (exists) continue;
    await c.query(
      `insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
       values ($1, $2,
               (((now() at time zone 'Asia/Shanghai')::date - $3::int) + time '09:00') at time zone 'Asia/Shanghai',
               $4, $5, $6, 'srpe', $7, 'manual')`,
      [me.org_id, me.athlete_id, x.d, x.sport, x.min * 60, Math.round(x.min * x.rpe), Math.round(x.rpe)]
    );
    n++;
  }

  // 恢复数据：最近 7 天睡眠与 HRV（含今天，否则今日页 HRV 只能是「—」）
  // 序列刻意平滑、今天落在基线附近：演示账号不该一登录就背一个假的「恢复极差」告警。
  const hrvSeries = [64, 63, 65, 64, 63, 65, 64, 64];
  const tstSeries = [470, 455, 480, 465, 450, 475, 460, 470];
  for (let i = 0; i <= 7; i++) {
    const tst = tstSeries[i];
    const hrv = hrvSeries[i];
    for (const [metric, value, unit] of [["sleep.tst", tst, "min"], ["hrv.rmssd", hrv, "ms"]]) {
      await c.query(
        `insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
         values ($1,$2, (now() at time zone 'Asia/Shanghai')::date - $3::int, $4, $5, $6, 'ok', 'manual', 'manual')
         on conflict (athlete_id, metric_date, metric_id) do update
           set value = excluded.value, updated_at = now()`,
        [me.org_id, me.athlete_id, i, metric, value, unit]
      );
    }
  }

  // 一次跳跃测试（CMJ 腾空 512 ms → 约 32 cm）
  const s = await one(
    `insert into public.test_sessions (org_id, athlete_id, kind, performed_at, source, protocol)
     values ($1,$2,'jump', now() - interval '1 day', 'manual', '{"method":"flight_time"}') returning id`,
    [me.org_id, me.athlete_id]
  );
  await c.query(
    `insert into public.jump_tests (session_id, jump_type, height_cm, flight_ms, contact_ms, rsi, video_fps, quality)
     values ($1,'cmj',32.1,512,null,null,240,'ok')`,
    [s.id]
  );

  // ── 规则版本 / 课库 / 周期计划 / 排课（0007 之后新增的三张核心表）──
  await c.query(
    `insert into public.rules (org_id, version, name, payload, is_active)
     values ($1, 'v1.0', '默认口径 v1.0', public.arc_default_rule_payload(), true)
     on conflict (org_id, version) do nothing`,
    [me.org_id]
  );

  // 课库：两节课 + 条目（绝对重量与 %1RM 互斥，这里分别示范两种写法）
  const lib = [
    { title: "下肢力量 · VBT", purpose: "strength", dur: 68, rpe: 7, tags: ["下肢", "VBT"],
      items: [
        { ex: "深蹲", sets: 5, reps: 3, pct: 80, rest: 180, vmin: 0.5 },
        { ex: "罗马尼亚硬拉", sets: 4, reps: 6, load: 100, rest: 120 },
        { ex: "保加利亚分腿蹲", sets: 3, reps: 8, load: 24, rest: 90 }
      ] },
    { title: "有氧恢复 · 自行车", purpose: "recovery", dur: 45, rpe: 3, tags: ["恢复"],
      items: [{ ex: "功率车 Z1", sets: 1, reps: null, dur: 2700, rest: null }] }
  ];
  let tplIds = [];
  for (const t of lib) {
    const exist = await one(`select id from public.session_templates where org_id = $1 and title = $2`, [me.org_id, t.title]);
    let tid = exist && exist.id;
    if (!tid) {
      const r = await one(
        `insert into public.session_templates (org_id, title, purpose, duration_min, intensity_rpe, tags, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [me.org_id, t.title, t.purpose, t.dur, t.rpe, t.tags, me.id]
      );
      tid = r.id;
      let seq = 1;
      for (const it of t.items) {
        await c.query(
          `insert into public.session_items (template_id, org_id, seq, exercise, sets, reps, load_kg, pct_1rm, duration_s, rest_s, vel_min)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tid, me.org_id, seq++, it.ex, it.sets, it.reps, it.load ?? null, it.pct ?? null, it.dur ?? null, it.rest ?? null, it.vmin ?? null]
        );
      }
    }
    tplIds.push(tid);
  }

  // 周期计划：本月 4 周，个人计划
  const cyc = await one(
    `select id from public.plan_cycles where org_id = $1 and athlete_id = $2 and name = '演示周期 · 基础期'`,
    [me.org_id, me.athlete_id]
  );
  let cycId = cyc && cyc.id;
  if (!cycId) {
    const r = await one(
      `insert into public.plan_cycles (org_id, athlete_id, name, goal, start_date, end_date, phase, status, created_by)
       values ($1,$2,'演示周期 · 基础期','演示用：建立有氧基底并维持力量',
               date_trunc('month', (now() at time zone 'Asia/Shanghai')::date)::date,
               (date_trunc('month', (now() at time zone 'Asia/Shanghai')::date) + interval '27 days')::date,
               'base','active',$3)
       returning id`,
      [me.org_id, me.athlete_id, me.id]
    );
    cycId = r.id;
    for (let w = 1; w <= 4; w++) {
      await c.query(
        `insert into public.plan_blocks (cycle_id, org_id, week_index, start_date, end_date, focus, target_load_min, target_load_max)
         values ($1,$2,$3::smallint,
                 (select start_date from public.plan_cycles where id = $1) + ($3::int - 1) * 7,
                 (select start_date from public.plan_cycles where id = $1) + ($3::int - 1) * 7 + 6,
                 $4, $5, $6)`,
        [cycId, me.org_id, w, ["解剖适应", "力量积累", "力量积累", "减量"][w - 1], 200 + w * 40, 320 + w * 40]
      );
    }
  }

  // 排课：今天一节（未完成）、昨天一节（已完成并挂上真实训练）
  for (const [offset, status] of [[0, "planned"], [1, "done"]]) {
    const d = await one(
      `select ((now() at time zone 'Asia/Shanghai')::date - $1::int)::date as d`, [offset]);
    const has = await one(
      `select id from public.session_assignments where athlete_id = $1 and scheduled_date = $2 and template_id = $3`,
      [me.athlete_id, d.d, tplIds[offset === 0 ? 0 : 1]]);
    if (has) continue;
    const act = status === "done"
      ? await one(`select id from public.activities where athlete_id = $1
                    and (started_at at time zone 'Asia/Shanghai')::date = $2::date limit 1`, [me.athlete_id, d.d])
      : null;
    await c.query(
      `insert into public.session_assignments (org_id, athlete_id, template_id, scheduled_date, status, activity_id, planned_load, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [me.org_id, me.athlete_id, tplIds[offset === 0 ? 0 : 1], d.d, status, act ? act.id : null,
       offset === 0 ? 320 : 155, me.id]
    );
  }

  // 触发一次全量重算（正常情况下由 activities 触发器自动完成，这里确保历史日期都算到）
  await c.query("select public.arc_recompute_metrics($1, current_date)", [me.athlete_id]);
  await c.query("select public.arc_recompute_recovery($1, current_date)", [me.athlete_id]);
  await c.query("commit");
  console.log(`已写入 ${n} 条训练、8 天恢复指标、1 次跳跃测试、2 节课库、1 个周期计划（账号 ${EMAIL}）`);
} catch (e) {
  await c.query("rollback");
  throw e;
} finally {
  const dm = await one(
    `select count(*)::int n, max(metric_date)::text last from public.daily_metrics where athlete_id = $1`,
    [me.athlete_id]
  );
  console.log(`指标行数 ${dm.n}，最后日期 ${dm.last}`);
  await c.end();
}
