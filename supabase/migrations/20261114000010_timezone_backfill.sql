-- ============================================================================
-- 第三世界 · 0010 时区与回填修正
--
-- 两个在演示账号上暴露出来的真问题：
--
-- (1) 凌晨 0–8 点写入的当天数据算不出来
--     库的 current_date 走 UTC。北京时间 11-14 03:30 时，UTC 还是 11-13，
--     于是 arc_recompute_* 的 v_to 停在 11-13，今天那一行永远是旧值。
--     修：v_to 默认取「组织时区的今天」，而不是 UTC 的今天。
--
-- (2) 补录历史不会带动后面的派生值
--     触发器只重算到「刚写入的那一天」。先写今天、后补上周，今天的基线就
--     还停留在「只有 1 个样本」的错误状态（实测 baseline 变成当天值、SWC=0）。
--     修：v_to 取 max(组织时区今天, 数据里最晚的一天)，一次算到底。
--
-- 这两个都是口径问题，不是显示问题：错的值会被当成真的用。
-- ============================================================================

begin;

-- ── 0. 组织时区的「今天」────────────────────────────────────────────────
create or replace function public.arc_local_today(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (now() at time zone coalesce((select o.timezone from public.orgs o where o.id = p_org), 'Asia/Shanghai'))::date;
$$;

revoke all on function public.arc_local_today(uuid) from public, anon;
grant execute on function public.arc_local_today(uuid) to authenticated;

-- ── 1. 负荷指标：v_to 默认 = max(本地今天, 最晚训练日) ────────────────────
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

  -- 一条训练都没有：把历史负荷指标清干净后返回
  if v_start is null then
    delete from public.daily_metrics m
    where m.athlete_id = p_athlete
      and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts','load.week');
    return 0;
  end if;

  v_to := coalesce(p_to, greatest(public.arc_local_today(v_org), v_last));

  for d in select generate_series(v_start, v_to, interval '1 day')::date loop
    select count(*), coalesce(sum(s.training_load), 0) into v_cnt, v_sum
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date = d
      and s.training_load is not null;

    if v_cnt = 0 then
      delete from public.daily_metrics m
      where m.athlete_id = p_athlete
        and m.metric_date = d
        and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts','load.week');
      continue;
    end if;

    v_tl := v_sum;

    select s.source into v_src
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date = d
    order by s.started_at desc limit 1;

    v_pctl := v_ctl; v_patl := v_atl;
    v_ctl := case when v_ctl is null then v_tl else v_ctl + (v_tl - v_ctl) / 42 end;
    v_atl := case when v_atl is null then v_tl else v_atl + (v_tl - v_atl) / 7 end;
    v_acu := case when v_acu is null then v_tl else v_acu + 0.25  * (v_tl - v_acu) end;
    v_chr := case when v_chr is null then v_tl else v_chr + 0.069 * (v_tl - v_chr) end;

    select count(*), coalesce(sum(s.training_load), 0), coalesce(stddev_pop(s.training_load), 0)
      into v_w7n, v_w7sum, v_w7sd
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date between d - 6 and d
      and s.training_load is not null;

    select count(*), coalesce(sum(s.training_load), 0) into v_w28n, v_w28sum
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date between d - 27 and d
      and s.training_load is not null;

    v_acwr := case when v_chr is not null and v_chr > 0 then v_acu / v_chr else null end;
    v_roll := case when v_w7n = 7 and v_w28n >= 26 and v_w28sum > 0
                   then (v_w7sum / 7.0) / (v_w28sum / v_w28n) else null end;
    v_tm   := case when v_w7n = 7 and v_w7sd > 0 then (v_w7sum / 7.0) / v_w7sd else null end;
    v_ts   := case when v_tm is not null then v_w7sum * v_tm else null end;

    insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
    select v_org, p_athlete, d, m.metric_id, m.val, m.unit,
           'ok'::metric_quality, coalesce(v_src, 'manual'::data_source), 'v1.0'
    from (values
        ('tl.srpe',       v_tl,   'AU'),
        ('ctl',           v_ctl,  'AU'),
        ('atl',           v_atl,  'AU'),
        ('tsb',           case when v_pctl is null or v_patl is null then null else v_pctl - v_patl end, 'AU'),
        ('acwr.ewma',     v_acwr, 'ratio'),
        ('acwr.rolling',  v_roll, 'ratio'),
        ('tm',            v_tm,   'ratio'),
        ('ts',            v_ts,   'AU'),
        ('load.week',     v_w7sum,'AU')
      ) as m(metric_id, val, unit)
    where m.val is not null
    on conflict (athlete_id, metric_date, metric_id) do update
      set value = excluded.value,
          unit = excluded.unit,
          quality = excluded.quality,
          source = excluded.source,
          calc_version = excluded.calc_version,
          updated_at = now();

    v_days := v_days + 1;
  end loop;

  return v_days;
end;
$$;

-- ── 2. 恢复指标：v_to 默认 = max(本地今天, 最晚恢复数据日) ────────────────
create or replace function public.arc_recompute_recovery(
  p_athlete uuid,
  p_to      date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    uuid;
  v_rules  jsonb;
  v_to     date;
  v_from   date;
  v_last   date;
  v_target numeric;
  d        date;
  v_rmssd  numeric;
  v_ln     numeric;
  v_bn     integer;
  v_base   numeric;
  v_swc    numeric;
  v_z      numeric;
  v_tst    numeric;
  v_debt   numeric;
  v_acwr   numeric;
  v_ready  jsonb;
  v_days   integer := 0;
begin
  if auth.uid() is not null and not public.can_write_athlete(p_athlete) then
    raise exception '无权写入该运动员的指标' using errcode = '42501';
  end if;

  select a.org_id into v_org from public.athletes a where a.id = p_athlete;
  if v_org is null then
    raise exception '运动员不存在：%', p_athlete using errcode = 'P0002';
  end if;

  v_rules  := public.arc_active_rule(v_org);
  v_target := coalesce((v_rules #>> '{sleep,target_min}')::numeric, 480);

  select min(metric_date), max(metric_date)
    into v_from, v_last
  from public.daily_metrics
  where athlete_id = p_athlete
    and metric_id in ('hrv.rmssd','sleep.tst');

  if v_from is null then
    return 0;
  end if;

  v_to := coalesce(p_to, greatest(public.arc_local_today(v_org), v_last));

  for d in
    select distinct metric_date
    from public.daily_metrics
    where athlete_id = p_athlete
      and metric_id in ('hrv.rmssd','sleep.tst')
      and metric_date between v_from and v_to
    order by 1
  loop
    select value into v_rmssd from public.daily_metrics
     where athlete_id = p_athlete and metric_date = d and metric_id = 'hrv.rmssd';
    select value into v_tst from public.daily_metrics
     where athlete_id = p_athlete and metric_date = d and metric_id = 'sleep.tst';
    select value into v_acwr from public.daily_metrics
     where athlete_id = p_athlete and metric_date = d and metric_id = 'acwr.ewma';

    v_ln := public.arc_hrv_lnrmssd(v_rmssd);

    select count(*), avg(ln(x.value)), stddev_pop(ln(x.value))
      into v_bn, v_base, v_swc
    from public.daily_metrics x
    where x.athlete_id = p_athlete
      and x.metric_id = 'hrv.rmssd'
      and x.value > 0
      and x.metric_date between d - 6 and d;

    if v_bn = 0 then
      v_bn := null;
      v_base := null;
      v_swc := null;
    else
      v_swc := case when v_swc is null then null else round(v_swc * 0.5, 4) end;
    end if;

    v_z := case
      when v_ln is null or v_base is null or v_swc is null or v_swc = 0 then null
      else round((v_ln - v_base) / v_swc, 3)
    end;

    select case when count(*) = 0 then null
                else greatest(0, round(7 * v_target - sum(x.value), 0)) end
      into v_debt
    from public.daily_metrics x
    where x.athlete_id = p_athlete
      and x.metric_id = 'sleep.tst'
      and x.metric_date between d - 6 and d;

    v_ready := public.arc_readiness_score(v_acwr, v_ln, v_base, v_swc, v_tst, v_rules);

    insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
    select v_org, p_athlete, d, m.metric_id, m.val, m.unit,
           case when v_bn is not null and v_bn >= 7 then 'ok'::metric_quality else 'partial'::metric_quality end,
           'manual'::data_source, 'v1.0'
    from (values
        ('hrv.lnrmssd', v_ln,                      'ln(ms)'),
        ('hrv.baseline', v_base,                   'ln(ms)'),
        ('hrv.swc',      v_swc,                    'ln(ms)'),
        ('hrv.z',        v_z,                      'ratio'),
        ('sleep.debt',   v_debt,                   'min'),
        ('readiness',    (v_ready ->> 'score')::numeric, 'score')
      ) as m(metric_id, val, unit)
    where m.val is not null
    on conflict (athlete_id, metric_date, metric_id) do update
      set value = excluded.value, unit = excluded.unit,
          quality = excluded.quality, updated_at = now();

    v_days := v_days + 1;
  end loop;

  return v_days;
end;
$$;

-- ── 3. 触发器改成「算到底」，不再只算到刚写入的那天 ──────────────────────
create or replace function public.arc_after_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_athlete uuid := coalesce(new.athlete_id, old.athlete_id);
begin
  begin
    perform public.arc_recompute_metrics(v_athlete, null);   -- null = 自动算到最新
  exception when others then
    insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
    values (auth.uid(), coalesce(new.org_id, old.org_id), 'metrics.recompute.failed',
            'athlete', v_athlete::text, jsonb_build_object('error', sqlerrm, 'state', sqlstate));
  end;
  return null;
end;
$$;

create or replace function public.arc_after_recovery_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.metric_id in ('hrv.rmssd','sleep.tst') then
    begin
      perform public.arc_recompute_recovery(new.athlete_id, null);   -- 补录历史也会带动后面的天
    exception when others then
      insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
      values (auth.uid(), new.org_id, 'recovery.recompute.failed', 'athlete', new.athlete_id::text,
              jsonb_build_object('error', sqlerrm, 'state', sqlstate));
    end;
  end if;
  return null;
end;
$$;

-- ── 4. 授权 ────────────────────────────────────────────────────────────────
revoke all on function public.arc_recompute_metrics(uuid, date)  from public, anon;
revoke all on function public.arc_recompute_recovery(uuid, date) from public, anon;
revoke all on function public.arc_after_activity()               from public, anon;
revoke all on function public.arc_after_recovery_metric()        from public, anon;
grant execute on function public.arc_recompute_metrics(uuid, date)  to authenticated;
grant execute on function public.arc_recompute_recovery(uuid, date) to authenticated;

-- ── 5. 自检 ────────────────────────────────────────────────────────────────
select 'arc_local_today 与组织时区一致'::text as item,
       (select (public.arc_local_today(o.id) = (now() at time zone o.timezone)::date)::text
          from public.orgs o limit 1), 'true'::text as expect
union all
select '重算不再用 UTC 的 current_date 作默认终点',
       (select case when prosrc not like '%greatest(public.arc_local_today%' then '0'
                    else (case when prosrc like '%coalesce(p_to, current_date)%' then '0' else '1' end) end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_recompute_metrics'), '1'
union all
select '恢复重算同样按本地今天兜底',
       (select case when prosrc like '%greatest(public.arc_local_today%' then '1' else '0' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_recompute_recovery'), '1'
union all
select '触发器传 null（算到最新）',
       (select case when prosrc like '%arc_recompute_metrics(v_athlete, null)%' then '1' else '0' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_after_activity'), '1';

commit;
