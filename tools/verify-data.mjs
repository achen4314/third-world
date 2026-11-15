#!/usr/bin/env node
/**
 * 第三世界 · 上线前数据与同步核验（只读）
 *
 * 目的：回答三个问题，并给出可复核的数字而不是「我觉得没问题」
 *   A 记录完整性 —— 该有的都有吗？有没有空值、孤行、未来日期、重复键
 *   B 计算正确性 —— 库里的派生值是否等于「从原始记录重新走一遍」的结果
 *   C 同步一致性 —— 登录用户（RLS）看到的行数/RPC 结果是否与服务端一致
 *
 * 只读保证：
 *   · 所有会话以 begin; ... rollback; 包裹，正常/异常路径都不留写入
 *   · 调用 arc_recompute_metrics 的幂等测试在事务内执行并回滚
 *
 * 用法：
 *   node tools/verify-data.mjs              # 全量
 *   node tools/verify-data.mjs --json       # 机器可读
 *   node tools/verify-data.mjs --only B     # 只跑某一组
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const ONLY = (() => { const i = argv.indexOf("--only"); return i > -1 ? argv[i + 1] : null; })();

function readEnv() {
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) throw new Error("缺少 .env.local（数据库连接串）");
  const env = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const rows = [];
const add = (group, name, ok, actual, expect, note) =>
  rows.push({ group, name, ok: ok === true ? true : ok === "warn" ? "warn" : false, actual, expect, note });

const env = readEnv();
// date / timestamp 一律按字符串取，避免 JS Date 把 '2026-11-14' 变成 'Sat Nov 14'
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);
const client = new pg.Client({
  connectionString: env.DIRECT_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000
});
await client.connect();

const q = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || {};

/** 在事务里跑，无论成功失败都回滚 —— 保证只读 */
async function inRollback(fn) {
  await client.query("begin");
  try { return await fn(); }
  finally { await client.query("rollback"); }
}

try {
  /* ═══════════════ A · 记录完整性 ═══════════════ */
  if (!ONLY || ONLY === "A") {
    const tbls = ["orgs", "teams", "app_users", "memberships", "athletes", "athlete_grants",
      "activities", "test_sessions", "jump_tests", "session_templates", "session_items",
      "session_assignments", "plan_cycles", "plan_blocks", "rules", "metric_registry",
      "daily_metrics", "devices", "device_credentials", "consents", "audit_logs", "invites"];
    const counts = {};
    for (const t of tbls) counts[t] = Number((await one(`select count(*)::int n from public.${t}`)).n);
    add("A 完整性", "各表行数", true,
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "), "可读");

    const ath = await one(`select count(*)::int n,
        count(*) filter (where birth_date is null)::int no_birth,
        count(*) filter (where height_cm is null)::int no_h,
        count(*) filter (where weight_kg is null)::int no_w,
        count(*) filter (where sex = 'unspecified')::int no_sex
      from public.athletes`);
    const missing = ath.no_birth + ath.no_h + ath.no_w + ath.no_sex;
    add("A 完整性", "运动员档案必填项", missing === 0 ? true : "warn",
      `${ath.n} 人 · 缺生日 ${ath.no_birth} / 身高 ${ath.no_h} / 体重 ${ath.no_w} / 性别 ${ath.no_sex}`,
      "0 空值",
      missing ? "缺体重会导致 PPO、相对强度无法计算；缺生日影响年龄分组。界面显示「—」不补造" : null);

    const act = await one(`select count(*)::int n,
        count(*) filter (where training_load is null)::int no_load,
        count(*) filter (where duration_s is null or duration_s <= 0)::int bad_dur,
        count(*) filter (where rpe is null)::int no_rpe,
        count(*) filter (where (started_at at time zone 'Asia/Shanghai')::date > (now() at time zone 'Asia/Shanghai')::date)::int future,
        count(*) filter (where sport is null or sport = '')::int no_sport
      from public.activities`);
    add("A 完整性", "训练记录字段完整", act.no_load + act.bad_dur + act.no_rpe + act.no_sport === 0 ? true : false,
      `${act.n} 条 · 缺负荷 ${act.no_load} · 时长异常 ${act.bad_dur} · 缺 RPE ${act.no_rpe} · 缺项目 ${act.no_sport}`,
      "全 0");
    add("A 完整性", "训练记录无未来日期", act.future === 0 ? true : false, `${act.future} 条`, "0 条");

    const dm = await one(`select count(*)::int n,
        count(distinct metric_date)::int days,
        min(metric_date) d0, max(metric_date) d1,
        count(*) filter (where value is null)::int nulls,
        count(*) filter (where value < 0)::int neg,
        count(*) filter (where metric_date > (now() at time zone 'Asia/Shanghai')::date)::int future
      from public.daily_metrics`);
    add("A 完整性", "指标行范围", dm.future === 0 && dm.nulls === 0 ? true : false,
      `${dm.n} 行 / ${dm.days} 天 · ${String(dm.d0).slice(0, 10)} → ${String(dm.d1).slice(0, 10)}`,
      "无空值无未来日期", `空值 ${dm.nulls} · 负数 ${dm.neg} · 未来 ${dm.future}`);

    const dup = await one(`select count(*)::int n from (
        select athlete_id, metric_date, metric_id from public.daily_metrics
        group by 1,2,3 having count(*) > 1) x`);
    add("A 完整性", "指标三键唯一", dup.n === 0 ? true : false, `${dup.n} 组重复`, "0 组");

    // 有训练的天是否都有 tl.srpe；有训练的天是否有状态量
    const gap = await one(`
      with days as (
        select distinct (started_at at time zone 'Asia/Shanghai')::date d
        from public.activities
      )
      select count(*)::int n,
             count(*) filter (where not exists (
               select 1 from public.daily_metrics m
               where m.metric_date = days.d and m.metric_id = 'tl.srpe'))::int no_tl,
             count(*) filter (where not exists (
               select 1 from public.daily_metrics m
               where m.metric_date = days.d and m.metric_id = 'atl'))::int no_atl
      from days`);
    add("A 完整性", "训练日必须落到指标表", gap.no_tl === 0 && gap.no_atl === 0 ? true : false,
      `${gap.n} 个训练日 · 缺 tl.srpe ${gap.no_tl} · 缺 atl ${gap.no_atl}`, "0 缺");

    // 休息日不应有 tl.srpe（缺测不补 0）
    const restBad = await one(`
      with rest as (
        select g::date d from generate_series(
          (select min((started_at at time zone 'Asia/Shanghai')::date) from public.activities),
          (select max(metric_date) from public.daily_metrics), interval '1 day') g
        where not exists (select 1 from public.activities a
          where (a.started_at at time zone 'Asia/Shanghai')::date = g::date)
      )
      select count(*)::int n from rest r
      join public.daily_metrics m on m.metric_date = r.d and m.metric_id = 'tl.srpe'`);
    add("A 完整性", "休息日未补 0 负荷", restBad.n === 0 ? true : false,
      `${restBad.n} 个休息日有 tl.srpe`, "0 个", "缺测不补 0 是硬约束");

    const jt = await one(`select count(*)::int n,
        count(*) filter (where session_id is null)::int no_sess,
        count(*) filter (where not exists (select 1 from public.test_sessions t where t.id = j.session_id))::int orphan,
        count(*) filter (where height_cm is null and contact_ms is null)::int empty
      from public.jump_tests j`);
    add("A 完整性", "跳跃测试可追溯", jt.orphan === 0 && jt.no_sess === 0 && jt.empty === 0 ? true : false,
      `${jt.n} 条 · 孤立 ${jt.orphan} · 无场次 ${jt.no_sess} · 空洞 ${jt.empty}`, "全 0");

    const sa = await one(`select count(*)::int n,
        count(*) filter (where template_id is null)::int no_tpl,
        count(*) filter (where planned_load is null)::int no_load,
        count(*) filter (where scheduled_date < (now() at time zone 'Asia/Shanghai')::date - 30)::int ancient
      from public.session_assignments`);
    add("A 完整性", "排课记录完整", sa.no_tpl === 0 && sa.no_load === 0 ? true : "warn",
      `${sa.n} 条 · 无模板 ${sa.no_tpl} · 无计划负荷 ${sa.no_load} · 30 天前 ${sa.ancient}`, "0 缺");

    const reg = await one(`select (select count(*)::int from public.metric_registry) defined,
        (select count(distinct metric_id)::int from public.daily_metrics) used`);
    add("A 完整性", "指标字典与实产指标", "warn",
      `字典 ${reg.defined} 个 · 已产出 ${reg.used} 个`, "已产出 ⊆ 字典", "未产出的多为尚未采集的来源（睡眠/HRV/VBT），属正常");

    const outOfDict = await one(`select count(distinct metric_id)::int n from public.daily_metrics
        where metric_id not in (select metric_id from public.metric_registry)`);
    add("A 完整性", "指标 id 全部在字典内", outOfDict.n === 0 ? true : false, `${outOfDict.n} 个越界`, "0 个");
  }

  /* ═══════════════ B · 计算正确性 ═══════════════ */
  if (!ONLY || ONLY === "B") {
    const ath = (await one(`select id, org_id from public.athletes limit 1`));

    // B1 独立重走：从 activities 逐日推进 EWMA，与库内值逐日比对
    const shadow = await inRollback(async () => {
      await client.query(`
        create temp table _shadow (d date primary key, tl numeric, ctl numeric, atl numeric, tsb numeric, acwr numeric) on commit drop;
        do $do$
        declare
          v_tz text; v_start date; v_to date; d date;
          v_cnt int; v_sum numeric; v_tl numeric;
          v_ctl numeric; v_atl numeric; v_acu numeric; v_chr numeric;
          v_pctl numeric; v_patl numeric;
        begin
          select coalesce(o.timezone,'Asia/Shanghai') into v_tz
          from public.athletes a join public.orgs o on o.id=a.org_id
          where a.id = '${ath.id}';
          select min((started_at at time zone v_tz)::date),
                 greatest(max((started_at at time zone v_tz)::date), (now() at time zone v_tz)::date)
            into v_start, v_to
          from public.activities where athlete_id = '${ath.id}';
          for d in select generate_series(v_start, v_to, interval '1 day')::date loop
            select count(*), coalesce(sum(training_load),0) into v_cnt, v_sum
            from public.activities
            where athlete_id = '${ath.id}'
              and (started_at at time zone v_tz)::date = d and training_load is not null;
            v_pctl := v_ctl; v_patl := v_atl;
            if v_cnt > 0 then
              v_tl := v_sum;
              v_ctl := case when v_ctl is null then v_tl else v_ctl + (v_tl - v_ctl)/42 end;
              v_atl := case when v_atl is null then v_tl else v_atl + (v_tl - v_atl)/7 end;
              v_acu := case when v_acu is null then v_tl else v_acu + 0.25*(v_tl - v_acu) end;
              v_chr := case when v_chr is null then v_tl else v_chr + 0.069*(v_tl - v_chr) end;
            else
              v_tl := null;
              v_ctl := case when v_ctl is null then null else v_ctl - v_ctl/42 end;
              v_atl := case when v_atl is null then null else v_atl - v_atl/7 end;
              v_acu := case when v_acu is null then null else v_acu - 0.25*v_acu end;
              v_chr := case when v_chr is null then null else v_chr - 0.069*v_chr end;
            end if;
            insert into _shadow values (
              d, v_tl,
              round(v_ctl, 3), round(v_atl, 3),
              round(case when v_pctl is null or v_patl is null then null else v_pctl - v_patl end, 3),
              round(case when v_chr is not null and v_chr > 0 then v_acu / v_chr end, 3)
            );
          end loop;
        end $do$;
      `);
      const diff = await one(`
        select
          count(*) filter (where s.tl   is not null and abs(s.tl - m_tl.value)   > 0.001)::int d_tl,
          count(*) filter (where s.ctl  is not null and abs(s.ctl - m_ctl.value) > 0.001)::int d_ctl,
          count(*) filter (where s.atl  is not null and abs(s.atl - m_atl.value) > 0.001)::int d_atl,
          count(*) filter (where s.tsb  is not null and abs(s.tsb - m_tsb.value) > 0.001)::int d_tsb,
          count(*) filter (where s.acwr is not null and abs(s.acwr - m_acwr.value) > 0.001)::int d_acwr,
          count(*) filter (where s.tl is not null and m_tl.value is null)::int miss_tl,
          count(*) filter (where s.tsb is not null and m_tsb.value is null)::int miss_tsb,
          count(*)::int total,
          coalesce(max(abs(s.atl - m_atl.value)),0)::numeric(12,4) max_atl,
          coalesce(max(abs(s.ctl - m_ctl.value)),0)::numeric(12,4) max_ctl
        from _shadow s
        left join public.daily_metrics m_tl   on m_tl.athlete_id='${ath.id}'   and m_tl.metric_date=s.d  and m_tl.metric_id='tl.srpe'
        left join public.daily_metrics m_ctl  on m_ctl.athlete_id='${ath.id}'  and m_ctl.metric_date=s.d and m_ctl.metric_id='ctl'
        left join public.daily_metrics m_atl  on m_atl.athlete_id='${ath.id}'  and m_atl.metric_date=s.d and m_atl.metric_id='atl'
        left join public.daily_metrics m_tsb  on m_tsb.athlete_id='${ath.id}'  and m_tsb.metric_date=s.d and m_tsb.metric_id='tsb'
        left join public.daily_metrics m_acwr on m_acwr.athlete_id='${ath.id}' and m_acwr.metric_date=s.d and m_acwr.metric_id='acwr.ewma'`);
      return diff;
    });
    const b1ok = shadow.d_tl + shadow.d_ctl + shadow.d_atl + shadow.d_tsb + shadow.d_acwr
      + shadow.miss_tl + shadow.miss_tsb === 0;
    add("B 计算", "负荷/EWMA 与独立重算一致", b1ok ? true : false,
      `${shadow.total} 天 · 超差 tl ${shadow.d_tl} ctl ${shadow.d_ctl} atl ${shadow.d_atl} tsb ${shadow.d_tsb} acwr ${shadow.d_acwr} · 该有为空 ${shadow.miss_tl + shadow.miss_tsb}`,
      "全 0", `容差 0.001（库内保留 4 位）；最大偏差 CTL ${shadow.max_ctl} / ATL ${shadow.max_atl}`);

    // B2 生产函数幂等（事务内执行后回滚）
    const idem = await inRollback(async () => {
      const before = await q(`select metric_date, metric_id, value from public.daily_metrics where athlete_id=$1 order by 1,2`, [ath.id]);
      await client.query(`select public.arc_recompute_metrics($1, $2)`, [ath.id, String((await one(`select max(metric_date) d from public.daily_metrics`)).d).slice(0, 10)]);
      const after = await q(`select metric_date, metric_id, value from public.daily_metrics where athlete_id=$1 order by 1,2`, [ath.id]);
      const key = (r) => `${String(r.metric_date).slice(0, 10)}|${r.metric_id}`;
      const m = new Map(after.map(r => [key(r), String(r.value)]));
      let changed = 0, gone = 0, added = 0;
      for (const r of before) {
        if (!m.has(key(r))) gone++;
        else if (String(r.value) !== m.get(key(r))) changed++;
      }
      for (const r of after) if (!before.find(b => key(b) === key(r))) added++;
      return { changed, gone, added, n: before.length };
    });
    add("B 计算", "重算幂等（同输入同输出）", idem.changed + idem.gone + idem.added === 0 ? true : false,
      `${idem.n} 行 · 变化 ${idem.changed} · 消失 ${idem.gone} · 新增 ${idem.added}`, "0 / 0 / 0",
      "在事务内执行后回滚，不改动线上数据");

    // B3 TSB 定义：TSB(d) = CTL(d-1) − ATL(d-1)（前一日状态之差，不是当日）
    const rel = await one(`
      with p as (select metric_date d,
        max(value) filter (where metric_id='ctl') ctl,
        max(value) filter (where metric_id='atl') atl,
        max(value) filter (where metric_id='tsb') tsb,
        max(value) filter (where metric_id='acwr.ewma') acwr
        from public.daily_metrics where athlete_id=$1 group by 1),
      l as (select d, ctl, atl, tsb, acwr,
        lag(ctl) over (order by d) p_ctl,
        lag(atl) over (order by d) p_atl from p)
      select count(*) filter (where tsb is not null and p_ctl is not null
                              and abs(tsb - (p_ctl - p_atl)) > 0.002)::int bad_tsb,
             count(*) filter (where acwr is not null and (acwr <= 0 or acwr > 3))::int wild_acwr,
             count(*)::int n
      from l`, [ath.id]);
    add("B 计算", "TSB = 前日 CTL−ATL", rel.bad_tsb === 0 ? true : false,
      `${rel.n} 天 · 违例 ${rel.bad_tsb} · ACWR 越界 ${rel.wild_acwr}`, "0 违例");

    // B4 休息日的状态量必须下降（训练日上升是正常的，只查无训练日）
    const decay = await one(`
      with tz as (select coalesce(o.timezone,'Asia/Shanghai') tz from public.orgs o
        join public.athletes a on a.org_id=o.id where a.id=$1),
      d as (select m.metric_date d, max(m.value) filter (where m.metric_id='atl') atl,
                   max(m.value) filter (where m.metric_id='ctl') ctl
        from public.daily_metrics m where m.athlete_id=$1 group by 1),
      lagged as (select d, atl, ctl, lag(atl) over (order by d) p_atl, lag(ctl) over (order by d) p_ctl from d)
      select count(*)::int n,
             count(*) filter (where atl > p_atl + 0.001)::int up_atl,
             count(*) filter (where ctl > p_ctl + 0.001)::int up_ctl,
             round(max(atl)::numeric,1) mx, round(min(atl)::numeric,1) mn
      from lagged x
      where atl is not null and p_atl is not null
        and not exists (select 1 from public.activities a, tz
          where a.athlete_id=$1 and (a.started_at at time zone tz.tz)::date = x.d)`, [ath.id]);
    add("B 计算", "休息日状态量下降", decay.up_atl === 0 && decay.up_ctl === 0 ? true : false,
      `${decay.n} 个休息日 · ATL 逆势上升 ${decay.up_atl} · CTL 逆势上升 ${decay.up_ctl} · ATL ${decay.mn}→${decay.mx}`,
      "0 上升", "连休不降会让 TSB 永远为负、就绪度继续建议加量");

    // B5 数值精度与异常
    const num = await one(`select
        count(*) filter (where value::text in ('NaN','Infinity','-Infinity'))::int nonfinite,
        count(*) filter (where scale(value) > 6)::int long_scale,
        count(*) filter (where metric_id like 'acwr%' and (value < 0 or value > 5))::int acwr_wild,
        count(*) filter (where metric_id='readiness' and (value < 0 or value > 100))::int ready_wild
      from public.daily_metrics`);
    add("B 计算", "数值无 NaN/越界", num.nonfinite + num.acwr_wild + num.ready_wild === 0 ? true : false,
      `非有限 ${num.nonfinite} · ACWR 越界 ${num.acwr_wild} · 就绪度越界 ${num.ready_wild}`, "全 0");
  }

  /* ═══════════════ C · 同步一致性（RLS 视角）═══════════════ */
  if (!ONLY || ONLY === "C") {
    // 前端实际读取的表（与 supabase-client.js 的 rest() 调用一一对应）
    const FE_TABLES = ["activities", "app_users", "athletes", "audit_logs", "consents",
      "daily_metrics", "devices", "memberships", "metric_registry", "orgs",
      "plan_blocks", "plan_cycles", "rules", "session_items", "session_templates", "test_sessions"];

    const svc = {};
    for (const t of FE_TABLES) svc[t] = Number((await one(`select count(*)::int n from public.${t}`)).n);

    const uid = (await one(`select id from auth.users where lower(email)='demo@third.world'`)).id;
    const authCounts = await inRollback(async () => {
      await client.query(`select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await client.query(`set local role authenticated`);
      const out = {};
      for (const t of FE_TABLES) {
        try { out[t] = Number((await one(`select count(*)::int n from public.${t}`)).n); }
        catch (e) { out[t] = "ERR:" + (e.code || e.message); }
      }
      return out;
    });

    // 旧断言要求「可见行数 = 服务端行数」，那是库里只有 1 个组织时的假设。
    // 真实上线后有多个组织，RLS 本就应把其他组织的行过滤掉；等于全量反而说明策略漏了。
    const bad = FE_TABLES.filter(t => {
      const a = authCounts[t];
      return typeof a !== "number" || a > svc[t];
    });
    const mustSee = ["activities", "athletes", "daily_metrics", "memberships"];
    const emptyBusiness = mustSee.filter(t => Number(authCounts[t]) === 0 && svc[t] > 0);
    const filtered = FE_TABLES.filter(t => Number(authCounts[t]) < svc[t]);
    add("C 同步", "RLS 生效：可见行数不超过服务端、业务表不为空",
      bad.length === 0 && emptyBusiness.length === 0 ? true : false,
      `${FE_TABLES.length} 张表 · ${filtered.length} 张被正常过滤` +
        (bad.length ? " · 异常 " + bad.join(",") : "") +
        (emptyBusiness.length ? " · 业务表全空 " + emptyBusiness.join(",") : ""),
      "无异常且业务表可见",
      "多组织下 RLS 过滤是预期行为；要求「全一致」是过时的单组织假设");

    // RPC 与表值对账：摘要里的 acwr 必须等于 daily_metrics 当日 acwr
    const rpcCheck = await inRollback(async () => {
      await client.query(`select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await client.query(`set local role authenticated`);
      const today = String((await one(`select public.arc_local_today($1) d`, [(await one(`select org_id from public.athletes limit 1`)).org_id])).d).slice(0, 10);
      const sum = await one(`select public.arc_daily_summary($1, $2) s`, [(await one(`select id from public.athletes limit 1`)).id, today]);
      const db = await one(`select
          max(value) filter (where metric_id='acwr.ewma') acwr,
          max(value) filter (where metric_id='atl') atl,
          max(value) filter (where metric_id='ctl') ctl,
          max(value) filter (where metric_id='readiness') ready
        from public.daily_metrics where athlete_id=(select id from public.athletes limit 1) and metric_date=$1`, [today]);
      return { today, sum: sum.s || {}, db };
    });
    const s = rpcCheck.sum;
    const numOf = (v) => (v === null || v === undefined ? null : Number(v));
    const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 0.002);
    const load = s.load || {};
    const acwrOk = same(numOf(load.acwr), numOf(rpcCheck.db.acwr));
    const atlOk = same(numOf(load.atl), numOf(rpcCheck.db.atl));
    const ctlOk = same(numOf(load.ctl), numOf(rpcCheck.db.ctl));
    const readyOk = same(numOf((s.readiness || {}).score), numOf(rpcCheck.db.ready));
    add("C 同步", "摘要 RPC 与指标表对账", acwrOk && atlOk && ctlOk ? true : "warn",
      `${rpcCheck.today} · RPC acwr=${numOf(load.acwr)} atl=${numOf(load.atl)} ctl=${numOf(load.ctl)} 就绪=${numOf((s.readiness || {}).score)} / 表 acwr=${numOf(rpcCheck.db.acwr)} atl=${numOf(rpcCheck.db.atl)} 就绪=${numOf(rpcCheck.db.ready)}`,
      "两侧一致", readyOk ? null : "就绪度两条路径口径不同，需核对 rules 权重是否取到同一版本");

    // 周计划：日期落在最近 7 天窗口、同日不重复、状态合法
    const week = await inRollback(async () => {
      await client.query(`select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await client.query(`set local role authenticated`);
      const r = await q(`select * from public.arc_week_plan($1, $2)`, [(await one(`select id from public.athletes limit 1`)).id, rpcCheck.today]);
      return r;
    });
    const days = (Array.isArray(week) ? week.flat() : []).map((d) => {
      if (typeof d === "string") { try { return JSON.parse(d); } catch { return {}; } }
      return d || {};
    });
    const dates = days.map(d => String(d.scheduled_date || d.date || "").slice(0, 10)).filter(Boolean);
    const todayMs = new Date(rpcCheck.today).getTime();
    const inWindow = dates.every(d => {
      const t = new Date(d).getTime();
      return t <= todayMs && t >= todayMs - 6 * 86400000;
    });
    const uniq = new Set(dates).size === dates.length;
    const okStatus = days.every(d => ["planned", "done", "missed", "skipped", "partial"].includes(String(d.status)));
    add("C 同步", "周计划窗口/去重/状态合法", inWindow && uniq && okStatus ? true : false,
      `${dates.length} 条排课 · ${dates[0] || "?"} → ${dates[dates.length - 1] || "?"} · 去重 ${uniq ? "是" : "否"} · 状态合法 ${okStatus ? "是" : "否"}`,
      "落在今日往前 7 天内");

    // 前端 28 日窗口的取数规模是否在 PostgREST 默认 1000 行内
    const windowRows = await one(`select count(*)::int n from public.daily_metrics
        where metric_date > (now() at time zone 'Asia/Shanghai')::date - 28`);
    add("C 同步", "28 日窗口行数在单次上限内", windowRows.n <= 1000 ? true : false,
      `${windowRows.n} 行`, "≤ 1000", "超出需分页，否则会被静默截断");

    // 索引能否支撑窗口查询
    const idx = await one(`select count(*)::int n from pg_indexes
        where schemaname='public' and tablename='daily_metrics'`);
    add("C 同步", "指标表索引", idx.n >= 2 ? true : "warn", `${idx.n} 个`, "≥ 2（按运动员+日期、按日期）");
  }

  /* ═══════════════ 输出 ═══════════════ */
  const pass = rows.filter(r => r.ok === true).length;
  const warn = rows.filter(r => r.ok === "warn").length;
  const fail = rows.filter(r => r.ok === false).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ at: new Date().toISOString(), pass, warn, fail, rows }, null, 2));
  } else {
    console.log("");
    console.log(C.b + "第三世界 · 上线前数据与同步核验" + C.x);
    console.log("─".repeat(94));
    let g = "";
    for (const r of rows) {
      if (r.group !== g) { g = r.group; console.log("\n" + C.c + C.b + g + C.x); }
      const mark = r.ok === true ? C.g + "✓" + C.x : r.ok === "warn" ? C.y + "!" + C.x : C.r + "✗" + C.x;
      console.log(`${mark} ${r.name}`);
      console.log(`    实际 ${String(r.actual).slice(0, 78)}`);
      if (r.note) console.log(C.d + `    ${r.note}` + C.x);
    }
    console.log("\n" + "─".repeat(94));
    console.log(`共 ${rows.length} 项：${C.g}✓ ${pass}${C.x} · ${C.y}! ${warn}${C.x} · ${fail ? C.r : ""}✗ ${fail}${C.x}`);
    console.log("");
  }
  process.exitCode = fail ? 2 : 0;
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("✗", e.code || "", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
