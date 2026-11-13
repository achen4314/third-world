-- ============================================================================
-- 第三世界 · 0009 修正：删除训练后当日负荷指标必须消失
--
-- 回归测试（tools/test-flows.mjs J 组）发现的问题：
--   arc_recompute_metrics 在「某天已无任何 activity」时执行 continue，
--   于是原来那天的 tl.srpe / ctl / atl / tsb / acwr / tm / ts 行**留在库里**。
--   结果是：删掉当天唯一一条训练，页面上那天的负荷还在——这不是「缺测不补 0」，
--   而是「删了还留着」，属于数据不实。
--
-- 修法：把「当天无训练」的分支从「跳过」改成「清掉该日的负荷类指标行」，
-- 只清这 8 个 metric_id，不碰恢复类（hrv.* / sleep.*）与测试类（jump.* / vbt.*）——
-- 那些是独立来源，不该被训练的删除连带抹掉。
-- ============================================================================

begin;

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
  v_to    date := coalesce(p_to, current_date);
  v_start date;
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

  select coalesce(o.timezone, 'Asia/Shanghai') into v_tz
  from public.athletes a join public.orgs o on o.id = a.org_id
  where a.id = p_athlete;

  if v_tz is null then
    raise exception '运动员不存在：%', p_athlete using errcode = 'P0002';
  end if;

  select a.org_id into v_org from public.athletes a where a.id = p_athlete;

  select min((s.started_at at time zone v_tz)::date) into v_start
  from public.activities s where s.athlete_id = p_athlete;

  -- 一条训练都没有：把历史负荷指标清干净后返回（不能留着旧值当「没发生过」）
  if v_start is null then
    delete from public.daily_metrics m
    where m.athlete_id = p_athlete
      and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts');
    return 0;
  end if;

  for d in select generate_series(v_start, v_to, interval '1 day')::date loop
    select count(*), coalesce(sum(s.training_load), 0) into v_cnt, v_sum
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date = d
      and s.training_load is not null;

    if v_cnt = 0 then
      -- 该日无训练：清掉负荷类派生值（缺测 = 无行），其余类别不动
      delete from public.daily_metrics m
      where m.athlete_id = p_athlete
        and m.metric_date = d
        and m.metric_id in ('tl.srpe','ctl','atl','tsb','acwr.ewma','acwr.rolling','tm','ts');
      continue;
    end if;

    v_tl := v_sum;

    select s.source into v_src
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date = d
    order by s.started_at desc limit 1;

    -- EWMA 负荷
    v_pctl := v_ctl; v_patl := v_atl;
    v_ctl := case when v_ctl is null then v_tl else v_ctl + (v_tl - v_ctl) / 42 end;
    v_atl := case when v_atl is null then v_tl else v_atl + (v_tl - v_atl) / 7 end;
    v_acu := case when v_acu is null then v_tl else v_acu + 0.25  * (v_tl - v_acu) end;
    v_chr := case when v_chr is null then v_tl else v_chr + 0.069 * (v_tl - v_chr) end;

    -- 7 日窗口（日历天，只有当天有记录才算有效天）
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

comment on function public.arc_recompute_metrics(uuid, date) is
  '负荷族指标重算。某日无训练则该日负荷类指标行被删除（缺测=无行，绝不补 0）；恢复类与测试类指标不受影响。';

revoke all on function public.arc_recompute_metrics(uuid, date) from public, anon;
grant execute on function public.arc_recompute_metrics(uuid, date) to authenticated;

select 'arc_recompute_metrics 只清负荷类指标'::text as item,
       (select case when prosrc like '%该日无训练：清掉负荷类派生值%' then '1' else '0' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_recompute_metrics'), '1'::text as expect
union all
select 'load.week 已纳入重算',
       (select case when count(*) > 0 then '1' else '0' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_recompute_metrics'
           and p.prosrc like '%load.week%'), '1';

commit;
