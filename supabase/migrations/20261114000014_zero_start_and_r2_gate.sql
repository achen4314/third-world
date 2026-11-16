-- ============================================================================
-- 第三世界 · 0014 口径变更：EWMA 从 0 起步 + 服务端 1RM 的 R² 门槛
--
-- 用户 2026-11-16 明确决定两项口径：
--   1) CTL / ATL 以及同一组 EWMA 状态量 acu / chr 从 0 起步，不再「首日 = 当天 TL」。
--      首日 CTL = TL/42、ATL = TL/7、acu = 0.25·TL、chr = 0.069·TL。
--   2) 服务端 arc_vbt_profile() 与前端 oneRM() 对齐：R² < 0.95 不输出 1RM。
--
-- 这会改变已产出的历史曲线，属于用户知情同意的口径变更；应用后必须对全部
-- 运动员重算（arc_recompute_metrics），否则新旧值会混在一张表里。
-- 0013 的幂等先删后写、休息日 source 重置、28 日窗口单次条件聚合均原样保留。
-- ACWR(rolling) 口径用户尚未决定，本迁移不动。
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. arc_recompute_metrics：只改四个状态量的初始化，其余逐字沿用 0013
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
  v_c0 numeric; v_a0 numeric; v_u0 numeric; v_h0 numeric;
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
      -- 0014：EWMA 从 0 起步。首日 ctl=v_tl/42、atl=v_tl/7、acu=0.25*v_tl、chr=0.069*v_tl。
      -- 四个状态量同系数起步，与前端 computeLoad() 的 c0/a0/u0/h0 逐字对应。
      v_c0 := coalesce(v_ctl, 0); v_a0 := coalesce(v_atl, 0);
      v_u0 := coalesce(v_acu, 0); v_h0 := coalesce(v_chr, 0);
      v_ctl := v_c0 + (v_tl - v_c0) / 42;
      v_atl := v_a0 + (v_tl - v_a0) / 7;
      v_acu := v_u0 + 0.25  * (v_tl - v_u0);
      v_chr := v_h0 + 0.069 * (v_tl - v_h0);
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
  '负荷与状态量重算（0014）：EWMA 四个状态量从 0 起步；保留 0013 幂等/休息日 source/单次扫描';

revoke all on function public.arc_recompute_metrics(uuid, date) from public, anon;
grant execute on function public.arc_recompute_metrics(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. arc_vbt_profile：新增 R² >= 0.95 门槛，与前端 oneRM() 同一硬条件。
--    顺序：样本量 -> 斜率 -> R²。任一不过都返回 ok:false 且不输出 load_1rm。
-- ---------------------------------------------------------------------------
create or replace function public.arc_vbt_profile(
  p_session   uuid,
  p_exercise  text,
  p_velocity  numeric default 0.3
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select v.load_kg::double precision as load, v.mpv::double precision as v
    from public.vbt_sets v
    where v.session_id = p_session
      and lower(v.exercise) = lower(p_exercise)
      and v.load_kg is not null and v.mpv is not null
      and v.mpv > 0
  ), fit as (
    select count(*)                                        as n,
           regr_slope(v, load)                             as slope,
           regr_intercept(v, load)                          as icy,
           regr_r2(v, load)                                 as r2,
           min(load)                                       as load_min,
           max(load)                                       as load_max
    from s
  )
  select case
    when f.n < 3 then jsonb_build_object(
      'n', f.n, 'ok', false,
      'reason', '负荷-速度剖面至少需要 3 个不同负荷点')
    when f.slope is null or f.slope >= 0 then jsonb_build_object(
      'n', f.n, 'ok', false,
      'reason', '速度为随负荷不降反升/持平，数据不可用于外推')
    when f.r2 is null or f.r2 < 0.95 then jsonb_build_object(
      'n', f.n, 'ok', false,
      'r2', round(f.r2::numeric, 4),
      'reason', 'LVP 回归 R² < 0.95，拟合不足，不输出 1RM')
    else jsonb_build_object(
      'n', f.n,
      'ok', true,
      'slope', round(f.slope::numeric, 5),
      'intercept', round(f.icy::numeric, 4),
      'r2', round(f.r2::numeric, 4),
      'load_min', f.load_min,
      'load_max', f.load_max,
      'velocity_1rm', p_velocity,
      'load_1rm', round(((p_velocity - f.icy) / f.slope)::numeric, 1),
      'note', '1RM 为外推值，超出实测负荷上限时仅供参考')
  end
  from fit f;
$$;

comment on function public.arc_vbt_profile(uuid, text, numeric) is
  '负荷-速度剖面（0014）：1RM 需同时满足 n>=3、斜率<0、R²>=0.95，否则 ok=false 且不给 load_1rm';

revoke all on function public.arc_vbt_profile(uuid, text, numeric) from public, anon;
grant execute on function public.arc_vbt_profile(uuid, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. 事务内自检：从 0 起步的首日值 + R² 门槛双向验证；临时数据随事务回滚/级联清理
-- ---------------------------------------------------------------------------
do $$
declare
  v_org  uuid;
  v_ath  uuid;
  v_sess uuid;
  v_day  date := date '2026-05-01';
  v_ctl  numeric;
  v_atl  numeric;
  v_acwr numeric;
  v_low  jsonb;
  v_high jsonb;
begin
  select id into v_org from public.orgs limit 1;
  if v_org is null then
    raise exception '0014 自检需要至少一个组织';
  end if;

  insert into public.athletes (org_id, full_name)
  values (v_org, '0014 自检临时运动员') returning id into v_ath;

  insert into public.activities
    (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
  values (v_org, v_ath, v_day + time '09:00', '力量', 3600, 100, 'srpe', 7, 'device');

  perform public.arc_recompute_metrics(v_ath, v_day);

  select max(value) filter (where metric_id = 'ctl'),
         max(value) filter (where metric_id = 'atl'),
         max(value) filter (where metric_id = 'acwr.ewma')
    into v_ctl, v_atl, v_acwr
  from public.daily_metrics
  where athlete_id = v_ath and metric_date = v_day;

  -- daily_metrics.value 是 numeric(12,4)，按 4 位小数容差比对，不用浮点全精度
  if abs(v_ctl - 100.0/42.0) > 5e-4 or abs(v_atl - 100.0/7.0) > 5e-4 then
    raise exception 'EWMA 未从 0 起步：CTL=% (期望 %) / ATL=% (期望 %)',
      v_ctl, 100.0/42.0, v_atl, 100.0/7.0;
  end if;
  if v_acwr is null or v_acwr <= 1 then
    raise exception '从 0 起步后首日 ACWR 应高于 1（急性收敛快于慢性），实际 %', v_acwr;
  end if;

  insert into public.test_sessions (org_id, athlete_id, kind, performed_at, source)
  values (v_org, v_ath, 'vbt', v_day + time '10:00', 'device')
  returning id into v_sess;

  -- 低 R²：速度随负荷非单调，斜率仍为负，但拟合很差
  insert into public.vbt_sets (session_id, exercise, load_kg, mpv) values
    (v_sess, 'back-squat', 60, 0.90),
    (v_sess, 'back-squat', 80, 0.70),
    (v_sess, 'back-squat', 100, 0.85);
  v_low := public.arc_vbt_profile(v_sess, 'back-squat', 0.3);
  if (v_low ->> 'ok') is distinct from 'false'
     or coalesce(v_low ->> 'reason', '') not like '%R²%' then
    raise exception 'R² 门槛未生效（低拟合应拒绝）：%', v_low;
  end if;
  if v_low ? 'load_1rm' then
    raise exception '低 R² 仍输出了 1RM：%', v_low;
  end if;

  -- 高 R²：完美线性，应放行
  update public.vbt_sets set mpv = 1.30 - 0.006 * load_kg
   where session_id = v_sess and exercise = 'back-squat';
  v_high := public.arc_vbt_profile(v_sess, 'back-squat', 0.3);
  if (v_high ->> 'ok') is distinct from 'true' or not (v_high ? 'load_1rm') then
    raise exception 'R² 门槛误杀（高拟合应放行）：%', v_high;
  end if;

  raise notice '0014 自检通过：首日 CTL=% ATL=% ACWR=% / 低拟合=% / 高拟合 R²=% 1RM=%',
    v_ctl, v_atl, v_acwr, v_low ->> 'reason', v_high ->> 'r2', v_high ->> 'load_1rm';

  delete from public.athletes where id = v_ath;
end;
$$;

commit;
