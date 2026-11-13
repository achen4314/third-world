-- ============================================================================
-- 第三世界 · 0011 把「状态量」和「日聚合量」分开
--
-- 问题（0010 之后暴露）：arc_recompute_metrics 对「当天没训练」的处理是整日跳过，
-- 于是 CTL / ATL / TSB / ACWR(EWMA) 这些**状态量**也跟着消失。
-- 结果：休息日打开今日页，负荷卡片是「—」；而教练真正要看的恰恰是「今天没练，
-- 但我的慢性负荷和急性负荷比是多少」。这跟「缺测不补 0」是两回事：
--   · TL、7 日负荷 = 日聚合量 → 没练就是没有值（不写 0）
--   · CTL/ATL/TSB/ACWR = 状态量 → 每天都存在，休息日按前一日值延续
--   · ACWR(rolling)/TM/TS = 窗口量 → 按各自的「7/7、≥26/28」有效性判定
--
-- 修法：每一天都推进状态量（无训练时不更新 EWMA，只延续），窗口量与日聚合量
-- 按各自规则写或是不写。
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

  -- 一条训练都没有：状态无从谈起，历史负荷指标全清
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

    -- 7 / 28 日窗口：只看「有记录的日历天」，与当天有没有训练无关
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
      -- 休息日：状态量延续，不更新 EWMA、不写 TL
      v_tl := null;
      delete from public.daily_metrics m
      where m.athlete_id = p_athlete and m.metric_date = d
        and m.metric_id in ('tl.srpe','load.week');
    end if;

    v_acwr := case when v_chr is not null and v_chr > 0 then v_acu / v_chr else null end;
    v_roll := case when v_w7n = 7 and v_w28n >= 26 and v_w28sum > 0
                   then (v_w7sum / 7.0) / (v_w28sum / v_w28n) else null end;
    v_tm   := case when v_w7n = 7 and v_w7sd > 0 then (v_w7sum / 7.0) / v_w7sd else null end;
    v_ts   := case when v_tm is not null then v_w7sum * v_tm else null end;

    -- 状态量：每天都写（只要已经开始有数据）
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

    -- 日聚合量：只有真的练了才写
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
  '负荷族指标重算。状态量（CTL/ATL/TSB/ACWR）逐日推进、休息日延续；日聚合量（TL/7 日负荷）只在有训练的日子写；两者都不补 0。';

revoke all on function public.arc_recompute_metrics(uuid, date) from public, anon;
grant execute on function public.arc_recompute_metrics(uuid, date) to authenticated;

-- 自检：造一个「练一天、休一天」的最小序列，验证状态量与日聚合量的差异
do $$
declare
  v_org uuid;
  v_ath uuid;
  v_d1  date := date '2026-01-05';
  v_d2  date := date '2026-01-06';
  v_tl_rest numeric;
  v_ctl_rest numeric;
  v_acwr_rest numeric;
begin
  -- 用已有组织建一个临时运动员（事务内，最后回滚）
  begin
    select id into v_org from public.orgs limit 1;
    insert into public.athletes (org_id, full_name) values (v_org, '自检用临时运动员') returning id into v_ath;
    insert into public.activities (org_id, athlete_id, started_at, sport, duration_s, training_load, load_method, rpe, source)
    values (v_org, v_ath, v_d1 + time '09:00', '力量', 3600, 100, 'srpe', 7, 'manual');
    perform public.arc_recompute_metrics(v_ath, v_d2);

    select value into v_tl_rest from public.daily_metrics
      where athlete_id = v_ath and metric_date = v_d2 and metric_id = 'tl.srpe';
    select value into v_ctl_rest from public.daily_metrics
      where athlete_id = v_ath and metric_date = v_d2 and metric_id = 'ctl';
    select value into v_acwr_rest from public.daily_metrics
      where athlete_id = v_ath and metric_date = v_d2 and metric_id = 'acwr.ewma';

    raise notice '休息日自检 TL=% (应为 null) / CTL=% (应为 100) / ACWR=% (应为 1)',
      v_tl_rest, v_ctl_rest, v_acwr_rest;

    if v_tl_rest is not null or v_ctl_rest is null or v_acwr_rest is null then
      raise exception '状态量与日聚合量未分离：TL=% CTL=% ACWR=%', v_tl_rest, v_ctl_rest, v_acwr_rest;
    end if;
  exception when others then
    raise;
  end;

  -- 回滚这个临时运动员
  delete from public.athletes where id = v_ath;
end;
$$;

select '状态量分离函数已替换'::text as item,
       (select case when prosrc like '%休息日：状态量延续%' then '1' else '0' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_recompute_metrics'), '1'::text as expect
union all
select '自检未留下临时运动员',
       (select count(*)::text from public.athletes where full_name = '自检用临时运动员'), '0';

commit;
