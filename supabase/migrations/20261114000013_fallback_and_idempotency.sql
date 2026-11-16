-- ============================================================================
-- 第三世界 · 0013 不涉口径的四项算法/一致性修复
--
-- 依据 docs/20-计算与指标专项审查-2026-11-16.md 末尾「不需要你定、可以直接修」清单。
-- 本迁移不改变任何计算口径、不改变已声明的公式系数、不回填历史数据；
-- 只修复「今天没训练时读不到状态量」「重算残留旧值」「休息日溯源错误」「重算 O(3N) 扫描」。
--
-- 需要用户先定口径的三项（rolling 口径 / EWMA 初始化 / R² 阈值）不在此文件内。
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- P0-1 + P0-3 + P1-3 + P1-4：arc_recompute_metrics
--   P0-3 每天写入前先整体删本函数负责的 9 个 metric_id，算成 null 不留旧值
--   P1-3 休息日把 v_src 重置为 null，不再继承上一个训练日的 device/import
--   P1-4 当日 / 7 日 / 28 日三次 activities 扫描合并成一次（28 日窗口内条件聚合）
-- ---------------------------------------------------------------------------
create or replace function public.arc_recompute_metrics(
  p_athlete uuid,
  p_to      date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz    text;
  v_org   uuid;
  v_to    date;
  v_start date;
  v_last  date;
  d       date;
  v_cnt   integer;
  v_sum   numeric;
  v_tl    numeric;
  v_src   data_source;
  v_ctl   numeric; v_atl numeric; v_acu numeric; v_chr numeric;
  v_pctl  numeric; v_patl numeric;
  v_w7n   integer; v_w7sum numeric; v_w7sd numeric;
  v_w28n  integer; v_w28sum numeric;
  v_acwr  numeric; v_roll numeric; v_tm numeric; v_ts numeric;
  v_days  integer := 0;
begin
  if auth.uid() is not null and not public.can_write_athlete(p_athlete) then
    raise exception '无权写入该运动员的指标' using errcode = '42501';
  end if;

  select a.org_id, coalesce(o.timezone, 'Asia/Shanghai')
    into v_org, v_tz
  from public.athletes a join public.orgs o on o.id = a.org_id
  where a.id = p_athlete;

  if v_tz is null then
    raise exception '运动员不存在：%', p_athlete using errcode = 'P0002';
  end if;

  select min((s.started_at at time zone v_tz)::date),
         max((s.started_at at time zone v_tz)::date)
    into v_start, v_last
  from public.activities s where s.athlete_id = p_athlete;

  if v_start is null then
    delete from public.daily_metrics m
    where m.athlete_id = p_athlete
      and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts','load.week');
    return 0;
  end if;

  v_to := coalesce(p_to, greatest(public.arc_local_today(v_org), v_last));

  for d in select generate_series(v_start, v_to, interval '1 day')::date loop

    -- P1-4：一次扫描 28 日窗口，用条件聚合同时产出当日 / 7 日 / 28 日三组量。
    -- 与拆分三次查询完全等价（含 count(*) 记「有记录条数」的语义），不碰口径。
    select count(*)                                                     filter (where s.day = d),
           coalesce(sum(s.training_load)                                filter (where s.day = d), 0),
           count(*)                                                     filter (where s.day between d - 6  and d),
           coalesce(sum(s.training_load)                                filter (where s.day between d - 6  and d), 0),
           coalesce(stddev_pop(s.training_load)                         filter (where s.day between d - 6  and d), 0),
           count(*)                                                     filter (where s.day between d - 27 and d),
           coalesce(sum(s.training_load)                                filter (where s.day between d - 27 and d), 0)
      into v_cnt, v_sum, v_w7n, v_w7sum, v_w7sd, v_w28n, v_w28sum
    from (
      select s.training_load, (s.started_at at time zone v_tz)::date as day
      from public.activities s
      where s.athlete_id = p_athlete
        and (s.started_at at time zone v_tz)::date between d - 27 and d
        and s.training_load is not null
    ) s;

    -- P0-3：本函数负责的指标先整日删除再写。以前只在休息日删 tl.srpe/load.week，
    -- 状态量算成 null 时既不插也不删，旧值会永久残留（rolling/tm/ts 一旦产出就会脏）。
    delete from public.daily_metrics m
    where m.athlete_id = p_athlete and m.metric_date = d
      and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts','load.week');

    v_pctl := v_ctl; v_patl := v_atl;

    if v_cnt > 0 then
      v_tl := v_sum;
      v_ctl := case when v_ctl is null then v_tl else v_ctl + (v_tl - v_ctl) / 42 end;
      v_atl := case when v_atl is null then v_tl else v_atl + (v_tl - v_atl) / 7 end;
      v_acu := case when v_acu is null then v_tl else v_acu + 0.25  * (v_tl - v_acu) end;
      v_chr := case when v_chr is null then v_tl else v_chr + 0.069 * (v_tl - v_chr) end;
      select s.source into v_src
      from public.activities s
      where s.athlete_id = p_athlete
        and (s.started_at at time zone v_tz)::date = d
      order by s.started_at desc limit 1;
    else
      -- 休息日：状态量按 0 负荷推进（0012 口径不变）；日聚合量不写、不补 0。
      v_tl  := null;
      v_ctl := case when v_ctl is null then null else v_ctl - v_ctl / 42 end;
      v_atl := case when v_atl is null then null else v_atl - v_atl / 7 end;
      v_acu := case when v_acu is null then null else v_acu - 0.25  * v_acu end;
      v_chr := case when v_chr is null then null else v_chr - 0.069 * v_chr end;
      -- P1-3：当天没有任何原始数据，不能沿用上一个训练日的 device / import。
      v_src := null;
    end if;

    -- 以下三项口径保持 0012 原样；rolling / tm / ts 的口径修订待用户确认后再做。
    v_acwr := case when v_chr is not null and v_chr > 0 then v_acu / v_chr else null end;
    v_roll := case when v_w7n = 7 and v_w28n >= 26 and v_w28sum > 0
                   then (v_w7sum / 7.0) / (v_w28sum / v_w28n) else null end;
    v_tm   := case when v_w7n = 7 and v_w7sd > 0 then (v_w7sum / 7.0) / v_w7sd else null end;
    v_ts   := case when v_tm is not null then v_w7sum * v_tm else null end;

    insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
    select v_org, p_athlete, d, m.metric_id, m.val, m.unit,
           'ok'::metric_quality, coalesce(v_src, 'manual'::data_source), 'v1.0'
    from (values
        ('ctl',           v_ctl,  'AU'),
        ('atl',           v_atl,  'AU'),
        ('tsb',           case when v_pctl is null or v_patl is null then null else v_pctl - v_patl end, 'AU'),
        ('acwr.ewma',     v_acwr, 'ratio'),
        ('acwr.rolling',  v_roll, 'ratio'),
        ('tm',            v_tm,   'ratio'),
        ('ts',            v_ts,   'AU')
      ) as m(metric_id, val, unit)
    where m.val is not null
    on conflict (athlete_id, metric_date, metric_id) do update
      set value = excluded.value,
          unit = excluded.unit,
          quality = excluded.quality,
          source = excluded.source,
          calc_version = excluded.calc_version,
          updated_at = now();

    if v_cnt > 0 then
      insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
      select v_org, p_athlete, d, m.metric_id, m.val, m.unit,
             'ok'::metric_quality, coalesce(v_src, 'manual'::data_source), 'v1.0'
      from (values
          ('tl.srpe',   v_tl,    'AU'),
          ('load.week', v_w7sum, 'AU')
        ) as m(metric_id, val, unit)
      where m.val is not null
      on conflict (athlete_id, metric_date, metric_id) do update
        set value = excluded.value,
            unit = excluded.unit,
            quality = excluded.quality,
            source = excluded.source,
            calc_version = excluded.calc_version,
            updated_at = now();
    end if;

    v_days := v_days + 1;
  end loop;

  return v_days;
end;
$$;

comment on function public.arc_recompute_metrics(uuid, date) is
  '负荷与状态量重算（0013）：幂等先删后写、休息日 source 重置、三次扫描合并为一次；口径未变';

revoke all on function public.arc_recompute_metrics(uuid, date) from public, anon;
grant execute on function public.arc_recompute_metrics(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- P0-1：arc_daily_summary 只读 fallback
-- 今日没训练 → 没有写 activities → 没有触发器 → daily_metrics 停在最后重算日。
-- 这里从「metric_date < v_day 的最后一组状态量」按 0012 同一组系数推进到 v_day：
--   ctl 每次 ×(1 − 1/42) = 41/42
--   atl 每次 ×(1 − 1/7)  = 6/7
--   acu 每次 ×(1 − 0.25) = 0.75；chr 每次 ×(1 − 0.069) = 0.931
--   acwr = acu/chr，故比值每次 ×0.75/0.931（无需单独存 acu/chr）
--   tsb(第 d 日) = 第 d−1 日 ctl − 第 d−1 日 atl
-- 只用于本次返回；不写库、不改历史曲线、不动任何既有口径。
-- ---------------------------------------------------------------------------
create or replace function public.arc_daily_summary(
  p_athlete uuid,
  p_date    date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    uuid;
  v_tz     text;
  v_rules  jsonb;
  v_day    date;
  v_load   jsonb;
  v_rec    jsonb;
  v_plan   jsonb;
  v_ready  jsonb;
  v_flags  jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_danger numeric;
  v_last_day date;
  v_lctl   numeric;
  v_latl   numeric;
  v_lacwr  numeric;
  v_gap    integer;
begin
  if not public.can_read_athlete(p_athlete) then
    raise exception '无权查看该运动员' using errcode = '42501';
  end if;

  select a.org_id, coalesce(o.timezone, 'Asia/Shanghai')
    into v_org, v_tz
  from public.athletes a join public.orgs o on o.id = a.org_id
  where a.id = p_athlete;

  v_rules  := public.arc_active_rule(v_org);
  v_danger := coalesce((v_rules #>> '{acwr,danger}')::numeric, 1.5);
  v_day    := coalesce(p_date, (now() at time zone v_tz)::date);

  select jsonb_build_object(
           'tl',  max(value) filter (where metric_id = 'tl.srpe'),
           'ctl', max(value) filter (where metric_id = 'ctl'),
           'atl', max(value) filter (where metric_id = 'atl'),
           'tsb', max(value) filter (where metric_id = 'tsb'),
           'acwr', max(value) filter (where metric_id = 'acwr.ewma'),
           'acwr_rolling', max(value) filter (where metric_id = 'acwr.rolling'),
           'tm',  max(value) filter (where metric_id = 'tm'),
           'ts',  max(value) filter (where metric_id = 'ts'),
           'quality', max(quality::text),
           'source', max(source::text)
         )
    into v_load
  from public.daily_metrics
  where athlete_id = p_athlete and metric_date = v_day
    and metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts');

  -- P0-1：缺哪几个状态量就补哪几个，已有值不覆盖。
  if (v_load ->> 'ctl') is null or (v_load ->> 'atl') is null
     or (v_load ->> 'acwr') is null or (v_load ->> 'tsb') is null then

    select max(m.metric_date),
           max(m.value) filter (where m.metric_id = 'ctl'),
           max(m.value) filter (where m.metric_id = 'atl'),
           max(m.value) filter (where m.metric_id = 'acwr.ewma')
      into v_last_day, v_lctl, v_latl, v_lacwr
    from public.daily_metrics m
    where m.athlete_id = p_athlete
      and m.metric_date < v_day
      and m.metric_id in ('ctl','atl','acwr.ewma');

    if v_last_day is not null and v_lctl is not null and v_latl is not null then
      v_gap := v_day - v_last_day;
      v_load := jsonb_build_object(
        'tl',            v_load -> 'tl',
        'ctl',           coalesce((v_load ->> 'ctl')::numeric,
                                  v_lctl * power(41.0 / 42.0, v_gap)),
        'atl',           coalesce((v_load ->> 'atl')::numeric,
                                  v_latl * power(6.0 / 7.0, v_gap)),
        'tsb',           coalesce((v_load ->> 'tsb')::numeric,
                                  v_lctl * power(41.0 / 42.0, greatest(v_gap - 1, 0))
                                - v_latl * power(6.0 / 7.0, greatest(v_gap - 1, 0))),
        'acwr',          coalesce((v_load ->> 'acwr')::numeric,
                                  case when v_lacwr is not null
                                       then v_lacwr * power(0.75 / 0.931, v_gap) end),
        'acwr_rolling',  v_load -> 'acwr_rolling',
        'tm',            v_load -> 'tm',
        'ts',            v_load -> 'ts',
        'quality',       v_load -> 'quality',
        'source',        v_load -> 'source'
      );
    end if;
  end if;

  select jsonb_build_object(
           'rmssd', max(value) filter (where metric_id = 'hrv.rmssd'),
           'lnrmssd', max(value) filter (where metric_id = 'hrv.lnrmssd'),
           'baseline', max(value) filter (where metric_id = 'hrv.baseline'),
           'swc', max(value) filter (where metric_id = 'hrv.swc'),
           'z', max(value) filter (where metric_id = 'hrv.z'),
           'sleep_tst', max(value) filter (where metric_id = 'sleep.tst'),
           'sleep_debt', max(value) filter (where metric_id = 'sleep.debt'),
           'quality', max(quality::text)
         )
    into v_rec
  from public.daily_metrics
  where athlete_id = p_athlete and metric_date = v_day
    and metric_id in ('hrv.rmssd','hrv.lnrmssd','hrv.baseline','hrv.swc','hrv.z','sleep.tst','sleep.debt');

  v_ready := public.arc_readiness_score(
    (v_load ->> 'acwr')::numeric,
    (v_rec  ->> 'lnrmssd')::numeric,
    (v_rec  ->> 'baseline')::numeric,
    (v_rec  ->> 'swc')::numeric,
    (v_rec  ->> 'sleep_tst')::numeric,
    v_rules
  );

  select coalesce(jsonb_agg(x order by x.scheduled_date), '[]'::jsonb) into v_plan
  from (
    select a.scheduled_date, a.status, t.title, t.purpose, t.duration_min, t.intensity_rpe
    from public.session_assignments a
    left join public.session_templates t on t.id = a.template_id
    where a.athlete_id = p_athlete and a.scheduled_date = v_day
  ) x;

  if (v_load ->> 'tl') is null then
    v_missing := v_missing || to_jsonb('当日无训练记录'::text);
  end if;
  if (v_rec ->> 'rmssd') is null then
    v_missing := v_missing || to_jsonb('当日无 HRV'::text);
  end if;
  if (v_rec ->> 'sleep_tst') is null then
    v_missing := v_missing || to_jsonb('当日无睡眠记录'::text);
  end if;
  if (v_load ->> 'acwr_rolling') is null then
    v_missing := v_missing || to_jsonb('滚动 ACWR 需 7/7 与 ≥26/28 有效天，当前不足'::text);
  end if;
  if v_ready ->> 'score' is null then
    v_missing := v_missing || to_jsonb('就绪度缺分量，不足以计算'::text);
  end if;

  if (v_load ->> 'acwr') is not null and (v_load ->> 'acwr')::numeric > v_danger then
    v_flags := v_flags || to_jsonb('负荷急增：ACWR 高于 ' || v_danger::text);
  end if;
  if (v_load ->> 'tm') is not null and (v_load ->> 'tm')::numeric > coalesce((v_rules #>> '{monotony_max}')::numeric, 2) then
    v_flags := v_flags || to_jsonb('训练单调性偏高（TM > 2）');
  end if;
  if v_ready ? 'flags' then
    v_flags := v_flags || (v_ready -> 'flags');
  end if;

  return jsonb_build_object(
    'athlete_id', p_athlete,
    'date', v_day,
    'timezone', v_tz,
    'load', v_load,
    'recovery', v_rec,
    'readiness', v_ready,
    'plan', v_plan,
    'flags', v_flags,
    'missing', v_missing,
    'rule_version', coalesce(
      (select r.version from public.rules r where r.org_id = v_org and r.is_active limit 1),
      'default')
  );
end;
$$;

comment on function public.arc_daily_summary(uuid, date) is
  '当日汇总（0013）：状态量缺行时按 0012 系数只读推进到查询日，不写库、不改历史';

revoke all on function public.arc_daily_summary(uuid, date) from public, anon;
grant execute on function public.arc_daily_summary(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 自检：幂等、P0-1 fallback、P1-3 source 重置、连休衰减仍成立
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid; v_ath uuid;
  v_d0 date := date '2026-04-01';
  v_d1 date := date '2026-04-02';
  v_next date;
  v_n1 integer; v_n2 integer;
  v_sum jsonb;
  v_src text;
  v_uid uuid;
  v_ctl_a numeric; v_ctl_b numeric;
begin
  select id into v_org from public.orgs limit 1;
  insert into public.athletes (org_id, full_name) values (v_org, '0013 自检临时运动员') returning id into v_ath;
  insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
  values (v_org, v_ath, v_d0 + time '09:00', '力量', 3600, 100, 'srpe', 7, 'device');

  perform public.arc_recompute_metrics(v_ath, v_d1);
  select count(*) into v_n1 from public.daily_metrics where athlete_id = v_ath;
  perform public.arc_recompute_metrics(v_ath, v_d1);
  select count(*) into v_n2 from public.daily_metrics where athlete_id = v_ath;
  if v_n1 <> v_n2 then
    raise exception 'P0-3 幂等失败：指标行数 %→%', v_n1, v_n2;
  end if;

  select max(source::text) into v_src from public.daily_metrics
   where athlete_id = v_ath and metric_date = v_d1 and metric_id = 'ctl';
  if v_src <> 'manual' then
    raise exception 'P1-3 休息日 source 未重置：%', v_src;
  end if;

  select metric_date + 1 into v_next from public.daily_metrics
   where athlete_id = v_ath order by metric_date desc limit 1;
  -- arc_daily_summary 带 can_read_athlete 校验；athletes.user_id 唯一，故临时建一个调用身份
  insert into auth.users (id, email)
  values (gen_random_uuid(), 'arc0013-' || gen_random_uuid() || '@tmp.test')
  returning id into v_uid;
  update public.athletes set user_id = v_uid where id = v_ath;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  v_sum := public.arc_daily_summary(v_ath, v_next);
  if (v_sum #>> '{load,ctl}') is null or (v_sum #>> '{load,atl}') is null
     or (v_sum #>> '{load,acwr}') is null or (v_sum #>> '{load,tsb}') is null then
    raise exception 'P0-1 只读 fallback 失败：%', v_sum -> 'load';
  end if;
  if (v_sum #>> '{load,tl}') is not null then
    raise exception '休息日不应产生 tl.srpe';
  end if;

  select value into v_ctl_a from public.daily_metrics
   where athlete_id = v_ath and metric_date = v_d0 and metric_id = 'ctl';
  select value into v_ctl_b from public.daily_metrics
   where athlete_id = v_ath and metric_date = v_d1 and metric_id = 'ctl';
  if v_ctl_b is null or v_ctl_b >= v_ctl_a then
    raise exception '连休状态量未衰减：CTL %→%', v_ctl_a, v_ctl_b;
  end if;

  raise notice '0013 自检通过：幂等 % 行 / 休息日 source=% / fallback CTL=% ATL=% ACWR=% / 连休 CTL %→%',
    v_n1, v_src, v_sum #>> '{load,ctl}', v_sum #>> '{load,atl}', v_sum #>> '{load,acwr}', v_ctl_a, v_ctl_b;
  delete from public.athletes where id = v_ath;
  delete from auth.users where id = v_uid;
end;
$$;

commit;
