-- ============================================================================
-- 第三世界 · 0008 具体计算引擎
--
-- 0006 只算「负荷」这一族（TL/CTL/ATL/TSB/ACWR/TM/TS）。这一版把剩下的
-- 所有算式补齐，并且**全部放在服务端**，前端只负责显示：
--
--   跳跃：h = g·t_f²/8；RSI = h / t_contact；PPO = 60.7·h + 45.3·m − 2055
--   速度：VL% = (1 − MPV/MPV_best)×100；功率 = load·g·MPV；
--         1RM 由负荷-速度线性剖面外推（v = a + b·load，取 v_1RM 处的负荷）
--   恢复：lnRMSSD = ln(RMSSD)；基准 = 7 日 lnRMSSD 均值；
--         SWC = 0.5·SD；偏离 z = (x − 基准)/SWC；睡眠债 = 7·目标 − 7 日累计
--   就绪：负荷/HRV/睡眠三分量加权，**缺哪个分量就把权重按比例分给其余**，
--         不把缺测当 0 分（那会把「没测」误判成「状态差」）
--
-- 另外补三件上线必需的服务端动作（原来都要靠 Edge Function，缺 PAT 就做不了）：
--   · arc_delete_activity()    删除一条训练（连带重算指标 + 留痕）
--   · arc_delete_my_account()  注销本人账号（真删 auth.users，级联清个人空间）
--   · arc_export_my_data()     一次性导出「我能看到的一切」（security invoker，走 RLS）
--
-- 口径一律以 docs/01 §9 与 metric_registry 为准；参数阈值来自 rules.payload
-- （arc_active_rule()），不在函数里硬编码。
-- ============================================================================

begin;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. 纯函数（immutable，可单独测）
-- ══════════════════════════════════════════════════════════════════════════

-- 1.1 飞行时间法跳跃高度（cm）。g = 9.81
create or replace function public.arc_jump_height(p_flight_ms numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_flight_ms is null or p_flight_ms <= 0 or p_flight_ms > 3000 then null
    else round(9.81 * power(p_flight_ms / 1000.0, 2) / 8 * 100, 2)
  end;
$$;

-- 1.2 反应力量指数 RSIm/s = 跳跃高度(m) / 触地时间(s)
create or replace function public.arc_jump_rsi(p_height_cm numeric, p_contact_ms numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_height_cm is null or p_height_cm <= 0 then null
    when p_contact_ms is null or p_contact_ms <= 0 then null
    else round((p_height_cm / 100.0) / (p_contact_ms / 1000.0), 3)
  end;
$$;

-- 1.3 峰值功率（Sayers 方程），需要体重；不给体重就不给值
create or replace function public.arc_jump_ppo(p_height_cm numeric, p_body_mass numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_height_cm is null or p_height_cm <= 0 then null
    when p_body_mass is null or p_body_mass <= 0 then null
    else round(60.7 * p_height_cm + 45.3 * p_body_mass - 2055, 1)
  end;
$$;

-- 1.4 速度损失百分比。mpv_best = 同组最快一次（通常是第一组）
create or replace function public.arc_vbt_vl(p_mpv numeric, p_mpv_best numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_mpv is null or p_mpv_best is null or p_mpv_best <= 0 then null
    when p_mpv <= 0 then null
    else round((1 - p_mpv / p_mpv_best) * 100, 2)
  end;
$$;

-- 1.5 平均机械功率 = load(kg) · g · MPV(m/s)
create or replace function public.arc_vbt_power(p_load_kg numeric, p_mpv numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_load_kg is null or p_mpv is null or p_load_kg < 0 or p_mpv <= 0 then null
    else round(p_load_kg * 9.81 * p_mpv, 1)
  end;
$$;

-- 1.6 lnRMSSD（自然对数）。RMSSD<=0 无意义，返回 null
create or replace function public.arc_hrv_lnrmssd(p_rmssd numeric)
returns numeric
language sql
immutable
as $$
  select case when p_rmssd is null or p_rmssd <= 0 then null else round(ln(p_rmssd), 4) end;
$$;

-- 1.7 睡眠效率 = 总睡眠 / 卧床 × 100
create or replace function public.arc_sleep_efficiency(p_tst_min numeric, p_tib_min numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_tst_min is null or p_tib_min is null or p_tib_min <= 0 then null
    when p_tst_min <= 0 or p_tst_min > p_tib_min * 1.05 then null   -- 明显矛盾的数据不给值
    else round(least(p_tst_min / p_tib_min * 100, 100), 1)
  end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 负荷-速度剖面：由一组 (load, MPV) 外推 1RM 与 R²
--    模型 v = a + b·load（线性）。b 必须为负，否则数据无意义。
--    v_1RM 取 rules.vbt.velocity_1rm（默认 0.3 m/s）。
-- ══════════════════════════════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 就绪度评分（可解释：返回每个分量与所用权重）
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_readiness_score(
  p_acwr     numeric,
  p_lnrmssd  numeric,
  p_baseline numeric,
  p_swc      numeric,
  p_tst      numeric,
  p_rules    jsonb default null
)
returns jsonb
language plpgsql
immutable
as $$
declare
  r            jsonb := coalesce(p_rules, public.arc_default_rule_payload());
  v_low        numeric := coalesce((r #>> '{acwr,low}')::numeric, 0.8);
  v_high       numeric := coalesce((r #>> '{acwr,high}')::numeric, 1.3);
  v_danger     numeric := coalesce((r #>> '{acwr,danger}')::numeric, 1.5);
  v_target     numeric := coalesce((r #>> '{sleep,target_min}')::numeric, 480);
  v_w_load     numeric := coalesce((r #>> '{readiness,acwr_w}')::numeric, 0.35);
  v_w_hrv      numeric := coalesce((r #>> '{readiness,hrv_w}')::numeric, 0.35);
  v_w_sleep    numeric := coalesce((r #>> '{readiness,sleep_w}')::numeric, 0.30);

  s_load  numeric;
  s_hrv   numeric;
  s_sleep numeric;
  z       numeric;
  wsum    numeric := 0;
  acc     numeric := 0;
  flags   jsonb  := '[]'::jsonb;
  parts   jsonb  := '{}'::jsonb;
  v_score numeric;
begin
  -- 负荷分量：理想带 [low, high] 得满分；偏低扣到 60；偏高按 danger 线性扣到 0
  if p_acwr is not null then
    s_load := case
      when p_acwr >= v_low and p_acwr <= v_high then 100
      when p_acwr < v_low then greatest(60, 100 - (v_low - p_acwr) / nullif(v_low, 0) * 40)
      else greatest(0, 100 - (p_acwr - v_high) / nullif(v_danger - v_high, 0) * 100)
    end;
    if p_acwr > v_danger then
      flags := flags || to_jsonb(('负荷急增（ACWR ' || round(p_acwr, 2)::text || ' > ' || v_danger::text || '）')::text);
    end if;
  end if;

  -- HRV 分量：以 0.5·SD 为尺度，偏离 +2 SWC = 100，−2 SWC = 0
  if p_lnrmssd is not null and p_baseline is not null and p_swc is not null and p_swc > 0 then
    z := (p_lnrmssd - p_baseline) / p_swc;
    s_hrv := least(100, greatest(0, 50 + z * 25));
    if z <= -1 then
      flags := flags || to_jsonb(('HRV 低于个人基准 ' || round(-z, 1)::text || ' SWC')::text);
    end if;
  end if;

  -- 睡眠分量：与目标时长之比（封顶 100）
  if p_tst is not null and p_tst > 0 then
    s_sleep := least(100, greatest(0, p_tst / nullif(v_target, 0) * 100));
  end if;

  -- 缺分量 → 权重重分配；全缺 → 不给分（返回 null，不写 0）
  if s_load  is not null then wsum := wsum + v_w_load;  acc := acc + s_load  * v_w_load;  end if;
  if s_hrv   is not null then wsum := wsum + v_w_hrv;   acc := acc + s_hrv   * v_w_hrv;   end if;
  if s_sleep is not null then wsum := wsum + v_w_sleep; acc := acc + s_sleep * v_w_sleep; end if;

  if wsum > 0 then
    v_score := round(acc / wsum, 0);
  end if;

  parts := jsonb_build_object(
    'load',  case when s_load  is null then null else round(s_load, 0)  end,
    'hrv',   case when s_hrv   is null then null else round(s_hrv, 0)   end,
    'sleep', case when s_sleep is null then null else round(s_sleep, 0) end,
    'z',     case when z is null then null else round(z, 2) end
  );

  return jsonb_build_object(
    'score',    v_score,
    'parts',    parts,
    'weights',  jsonb_build_object('load', v_w_load, 'hrv', v_w_hrv, 'sleep', v_w_sleep),
    'coverage', case when wsum > 0 then round(wsum / (v_w_load + v_w_hrv + v_w_sleep), 2) else 0 end,
    'flags',    flags
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 跳跃测试：写入即补全派生量（行内 + 指标行）
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_before_jump()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- 有飞行时间但没写高度：服务端补算，不让用户自己算
  if new.height_cm is null then
    new.height_cm := public.arc_jump_height(new.flight_ms);
  end if;
  -- 有高度与触地时间但没写 RSI：补算
  if new.rsi is null then
    new.rsi := public.arc_jump_rsi(new.height_cm, new.contact_ms);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_jump_before on public.jump_tests;
create trigger trg_jump_before
  before insert or update of flight_ms, contact_ms, height_cm on public.jump_tests
  for each row execute function public.arc_before_jump();

create or replace function public.arc_after_jump()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_athlete uuid;
  v_org     uuid;
  v_tz      text;
  v_day     date;
  v_mass    numeric;
  v_ppo     numeric;
begin
  select s.athlete_id, s.org_id, coalesce(o.timezone, 'Asia/Shanghai'),
         (s.performed_at at time zone coalesce(o.timezone, 'Asia/Shanghai'))::date
    into v_athlete, v_org, v_tz, v_day
  from public.test_sessions s join public.orgs o on o.id = s.org_id
  where s.id = new.session_id;

  if v_athlete is null then
    return null;
  end if;

  select weight_kg into v_mass from public.athletes where id = v_athlete;
  v_ppo := public.arc_jump_ppo(new.height_cm, v_mass);

  insert into public.daily_metrics (org_id, athlete_id, metric_date, metric_id, value, unit, quality, source, calc_version)
  select v_org, v_athlete, v_day, m.metric_id, m.val, m.unit,
         case when m.val is null then 'missing'::metric_quality else 'ok'::metric_quality end,
         'manual'::data_source, 'v1.0'
  from (values
      ('jump.height',        new.height_cm, 'cm'),
      ('jump.rsi',           new.rsi,       'm/s'),
      ('jump.contact_time',  new.contact_ms,'ms'),
      ('jump.ppo',           v_ppo,         'W')
    ) as m(metric_id, val, unit)
  where m.val is not null
  on conflict (athlete_id, metric_date, metric_id) do update
    set value = excluded.value, unit = excluded.unit,
        quality = excluded.quality, updated_at = now();

  return null;
end;
$$;

drop trigger if exists trg_jump_metrics on public.jump_tests;
create trigger trg_jump_metrics
  after insert or update on public.jump_tests
  for each row execute function public.arc_after_jump();

-- ══════════════════════════════════════════════════════════════════════════
-- 5. VBT：写入即算速度损失与功率
--    MPV_best 取「同一次测试、同一动作」内最快的那个值；
--    该值随插入顺序变化，所以每次写入都重算本组所有行的 VL（幂等）。
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_after_vbt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_best numeric;
begin
  select max(v.mpv) into v_best
  from public.vbt_sets v
  where v.session_id = new.session_id
    and lower(v.exercise) = lower(new.exercise)
    and v.mpv is not null and v.mpv > 0;

  update public.vbt_sets v
     set vl_pct = public.arc_vbt_vl(v.mpv, v_best),
         power_w = coalesce(v.power_w, public.arc_vbt_power(v.load_kg, v.mpv))
   where v.session_id = new.session_id
     and lower(v.exercise) = lower(new.exercise)
     and (v.vl_pct is distinct from public.arc_vbt_vl(v.mpv, v_best)
          or v.power_w is null);

  return null;
end;
$$;

drop trigger if exists trg_vbt_metrics on public.vbt_sets;
create trigger trg_vbt_metrics
  after insert or update of mpv, load_kg on public.vbt_sets
  for each row execute function public.arc_after_vbt();

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 恢复类指标：lnRMSSD / 基准 / SWC / 偏离 / 睡眠债 / 就绪度
--    窗口一律「含当日的过去 7 天」，缺测日不补 0（只是不计入分母）。
-- ══════════════════════════════════════════════════════════════════════════
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
  v_to     date := coalesce(p_to, current_date);
  v_from   date;
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

  select min(metric_date) into v_from
  from public.daily_metrics
  where athlete_id = p_athlete
    and metric_id in ('hrv.rmssd','sleep.tst')
    and metric_date <= v_to;

  if v_from is null then
    return 0;
  end if;

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

    -- 7 日基准与 SWC（只要窗口内有过有效值就算，样本数单独记）
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
      v_swc := case when v_swc is null then null else round(v_swc * 0.5, 4) end;  -- SWC = 0.5·SD
    end if;

    v_z := case
      when v_ln is null or v_base is null or v_swc is null or v_swc = 0 then null
      else round((v_ln - v_base) / v_swc, 3)
    end;

    -- 睡眠债：7 日累计缺口，只在确实有睡眠记录时给
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

-- 写入恢复原始值后自动派生（失败留痕，不阻塞写入）
create or replace function public.arc_after_recovery_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.metric_id in ('hrv.rmssd','sleep.tst') then
    begin
      perform public.arc_recompute_recovery(new.athlete_id, new.metric_date);
    exception when others then
      insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
      values (auth.uid(), new.org_id, 'recovery.recompute.failed', 'athlete', new.athlete_id::text,
              jsonb_build_object('error', sqlerrm, 'state', sqlstate));
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recovery_metrics on public.daily_metrics;
create trigger trg_recovery_metrics
  after insert or update of value on public.daily_metrics
  for each row execute function public.arc_after_recovery_metric();

-- ══════════════════════════════════════════════════════════════════════════
-- 7. 当日总览：把「负荷 / 恢复 / 计划 / 缺测」拼成一个可解释的 jsonb
--    前端只渲染，不做任何再计算；每个结论都带 source 与 quality。
-- ══════════════════════════════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════════════════════════════
-- 8. 团队总览（教练工作台）：只统计「调用者能读到」的运动员
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_team_overview(
  p_org  uuid,
  p_team uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rules   jsonb;
  v_danger  numeric;
  v_tz      text;
  v_today   date;
  v_members integer;
  v_warn    integer;
  v_thin    integer;
  v_load7   numeric;
  v_avg_acwr numeric;
  v_avg_ready numeric;
  v_rows    jsonb;
begin
  if not public.is_org_member(p_org) then
    raise exception '无权查看该组织' using errcode = '42501';
  end if;

  select coalesce(o.timezone, 'Asia/Shanghai') into v_tz from public.orgs o where o.id = p_org;
  v_today := (now() at time zone v_tz)::date;
  v_rules := public.arc_active_rule(p_org);
  v_danger := coalesce((v_rules #>> '{acwr,danger}')::numeric, 1.5);

  with mine as (
    select a.id, a.full_name, a.team_id, a.status
    from public.athletes a
    where a.org_id = p_org
      and (p_team is null or a.team_id = p_team)
      and public.can_read_athlete(a.id)
  ), agg as (
    select m.id, m.full_name,
           sum(d.value) filter (where d.metric_id = 'tl.srpe'    and d.metric_date > v_today - 7)  as load7,
           max(d.value) filter (where d.metric_id = 'acwr.ewma' and d.metric_date = v_today)       as acwr,
           max(d.value) filter (where d.metric_id = 'readiness' and d.metric_date = v_today)       as readiness,
           count(*) filter (where d.metric_date = v_today)                                        as today_rows,
           max(d.metric_date)                                                                     as last_date
    from mine m
    left join public.daily_metrics d
      on d.athlete_id = m.id and d.metric_date > v_today - 28
    group by m.id, m.full_name
  )
  select count(*),
         count(*) filter (where acwr is not null and acwr > v_danger),
         count(*) filter (where readiness is null),
         coalesce(round(sum(load7), 0), 0),
         round(avg(acwr), 3),
         round(avg(readiness), 0),
         coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'name', full_name, 'load7', coalesce(load7, 0),
             'acwr', acwr, 'readiness', readiness, 'last_date', last_date,
             'status', case
               when acwr is not null and acwr > v_danger then 'warn'
               when readiness is null then 'thin'
               else 'ok' end
           ) order by full_name), '[]'::jsonb)
    into v_members, v_warn, v_thin, v_load7, v_avg_acwr, v_avg_ready, v_rows
  from agg;

  return jsonb_build_object(
    'org_id', p_org, 'team_id', p_team, 'date', v_today,
    'members', v_members, 'warn', v_warn, 'thin', v_thin,
    'load7', v_load7, 'avg_acwr', v_avg_acwr, 'avg_readiness', v_avg_ready,
    'rule_version', coalesce((select r.version from public.rules r where r.org_id = p_org and r.is_active limit 1), 'default'),
    'members_detail', v_rows
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. 删除训练（替代原计划的 Edge Function）
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_delete_activity(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.activities%rowtype;
begin
  select * into a from public.activities where id = p_id;
  if a.id is null then
    raise exception '训练记录不存在' using errcode = 'P0002';
  end if;
  if not public.can_write_athlete(a.athlete_id) then
    raise exception '无权删除该训练记录' using errcode = '42501';
  end if;

  -- 先留痕（删除后行就没了；audit_logs 不存数值内容，只存定位信息）
  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (auth.uid(), a.org_id, 'activity.delete', 'activities', p_id::text,
          jsonb_build_object('sport', a.sport, 'started_at', a.started_at,
                             'training_load', a.training_load, 'athlete_id', a.athlete_id));

  delete from public.activities where id = p_id;
  -- activities 的删除触发器会重算该运动员指标
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 10. 注销本人账号
--     规则：只删「自己是唯一成员」的组织（个人空间），共享组织里的团队数据保留，
--     但运动员档案上的 user_id 会被置空（外键 on delete set null），不再指向任何人。
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_solo uuid[];
  v_org  uuid;
begin
  if v_uid is null then
    raise exception '未登录' using errcode = '28000';
  end if;

  select coalesce(array_agg(m.org_id), '{}'::uuid[]) into v_solo
  from public.memberships m
  where m.user_id = v_uid
    and (select count(*) from public.memberships x where x.org_id = m.org_id) = 1;

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, null, 'account.delete', 'app_users', v_uid::text,
          jsonb_build_object('solo_orgs', to_jsonb(v_solo)));

  foreach v_org in array coalesce(v_solo, '{}'::uuid[]) loop
    delete from public.orgs where id = v_org;   -- 级联清掉个人空间里的训练与指标
  end loop;

  delete from public.app_users where id = v_uid;         -- 级联 memberships / consents
  delete from auth.users where id = v_uid;               -- 真正的账号
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 11. 一次性导出（security invoker：RLS 照常生效，导不出别人的）
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_export_my_data()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schema', 'arc-export/1',
    'generated_at', now(),
    'user', coalesce(
      (select to_jsonb(u) from (
         select id, display_name, locale, created_at from public.app_users where id = auth.uid()
       ) u), 'null'::jsonb),
    'memberships', coalesce((select jsonb_agg(to_jsonb(m))
       from public.memberships m where m.user_id = auth.uid()), '[]'::jsonb),
    'orgs', coalesce((select jsonb_agg(to_jsonb(o)) from public.orgs o), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(to_jsonb(t)) from public.teams t), '[]'::jsonb),
    'athletes', coalesce((select jsonb_agg(to_jsonb(a)) from public.athletes a), '[]'::jsonb),
    'activities', coalesce((select jsonb_agg(to_jsonb(x))
       from (select * from public.activities order by started_at desc limit 5000) x), '[]'::jsonb),
    'daily_metrics', coalesce((select jsonb_agg(to_jsonb(y))
       from (select * from public.daily_metrics order by metric_date desc limit 20000) y), '[]'::jsonb),
    'test_sessions', coalesce((select jsonb_agg(to_jsonb(s)) from public.test_sessions s), '[]'::jsonb),
    'jump_tests', coalesce((select jsonb_agg(to_jsonb(j)) from public.jump_tests j), '[]'::jsonb),
    'vbt_sets', coalesce((select jsonb_agg(to_jsonb(v)) from public.vbt_sets v), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d)) from public.devices d), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(p)) from public.plan_cycles p), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(to_jsonb(sa)) from public.session_assignments sa), '[]'::jsonb),
    'consents', coalesce((select jsonb_agg(to_jsonb(c)) from public.consents c where c.user_id = auth.uid()), '[]'::jsonb)
  );
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 12. 指标注册表补齐（新增派生指标必须先登记，daily_metrics 有外键）
-- ══════════════════════════════════════════════════════════════════════════
insert into public.metric_registry (metric_id, label, unit, category, formula, calc_version, tier, is_sensitive, notes)
values
  ('readiness',    '就绪度',                        'score',  'recovery',
   '加权：负荷分×0.35 + HRV分×0.35 + 睡眠分×0.30（缺分量按比例重分配）', 'v1.0', 'core', false,
   '缺测不当 0 分；coverage < 1 时仅供参考'),
  ('hrv.baseline', 'HRV 基准（7 日 lnRMSSD 均值）', 'ln(ms)', 'recovery',
   'mean(ln(RMSSD)) over 当日及前 6 日', 'v1.0', 'core', false, null),
  ('hrv.swc',      'HRV 最小有意义变化 SWC',         'ln(ms)', 'recovery',
   '0.5 × SD(ln(RMSSD)) over 7 日窗口', 'v1.0', 'core', false, null),
  ('hrv.z',        'HRV 偏离（SWC 倍数）',           'ratio',  'recovery',
   '(lnRMSSD − 基准) / SWC', 'v1.0', 'core', false, null),
  ('sleep.debt',   '睡眠债（7 日累计缺口）',          'min',    'recovery',
   'max(0, 7×目标时长 − Σ7 日 TST)', 'v1.0', 'core', false, null),
  ('load.week',    '7 日累计负荷',                   'AU',     'load',
   'Σ training_load over 7 日窗口', 'v1.0', 'core', false, null)
on conflict (metric_id) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 13. 授权收口
-- ══════════════════════════════════════════════════════════════════════════
revoke all on function public.arc_jump_height(numeric)                 from public, anon;
revoke all on function public.arc_jump_rsi(numeric, numeric)           from public, anon;
revoke all on function public.arc_jump_ppo(numeric, numeric)           from public, anon;
revoke all on function public.arc_vbt_vl(numeric, numeric)             from public, anon;
revoke all on function public.arc_vbt_power(numeric, numeric)          from public, anon;
revoke all on function public.arc_hrv_lnrmssd(numeric)                 from public, anon;
revoke all on function public.arc_sleep_efficiency(numeric, numeric)   from public, anon;
revoke all on function public.arc_vbt_profile(uuid, text, numeric)     from public, anon;
revoke all on function public.arc_readiness_score(numeric, numeric, numeric, numeric, numeric, jsonb) from public, anon;
revoke all on function public.arc_recompute_recovery(uuid, date)       from public, anon;
revoke all on function public.arc_daily_summary(uuid, date)            from public, anon;
revoke all on function public.arc_team_overview(uuid, uuid)            from public, anon;
revoke all on function public.arc_delete_activity(uuid)                from public, anon;
revoke all on function public.arc_delete_my_account()                  from public, anon;
revoke all on function public.arc_export_my_data()                     from public, anon;
revoke all on function public.arc_before_jump()                        from public, anon;
revoke all on function public.arc_after_jump()                         from public, anon;
revoke all on function public.arc_after_vbt()                          from public, anon;
revoke all on function public.arc_after_recovery_metric()              from public, anon;

grant execute on function public.arc_jump_height(numeric)              to authenticated;
grant execute on function public.arc_jump_rsi(numeric, numeric)        to authenticated;
grant execute on function public.arc_jump_ppo(numeric, numeric)        to authenticated;
grant execute on function public.arc_vbt_vl(numeric, numeric)          to authenticated;
grant execute on function public.arc_vbt_power(numeric, numeric)       to authenticated;
grant execute on function public.arc_hrv_lnrmssd(numeric)              to authenticated;
grant execute on function public.arc_sleep_efficiency(numeric, numeric) to authenticated;
grant execute on function public.arc_vbt_profile(uuid, text, numeric)  to authenticated;
grant execute on function public.arc_readiness_score(numeric, numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.arc_recompute_recovery(uuid, date)    to authenticated;
grant execute on function public.arc_daily_summary(uuid, date)         to authenticated;
grant execute on function public.arc_team_overview(uuid, uuid)         to authenticated;
grant execute on function public.arc_delete_activity(uuid)             to authenticated;
grant execute on function public.arc_delete_my_account()               to authenticated;
grant execute on function public.arc_export_my_data()                  to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 14. 自检
-- ══════════════════════════════════════════════════════════════════════════
select '计算函数（应为 9）'::text as item,
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in
           ('arc_jump_height','arc_jump_rsi','arc_jump_ppo','arc_vbt_vl','arc_vbt_power',
            'arc_hrv_lnrmssd','arc_sleep_efficiency','arc_vbt_profile','arc_readiness_score')), '9'::text as expect
union all
select '跳跃高度 0.600s 应为 44.15cm',
       public.arc_jump_height(600)::text, '44.15'
union all
select 'RSI(44.15cm, 500ms) 应为 0.883',
       public.arc_jump_rsi(44.15, 500)::text, '0.883'
union all
select 'PPO(44.15cm, 74kg) 应为 3977.1',
       public.arc_jump_ppo(44.15, 74)::text, '3977.1'
union all
select 'VL(0.60, 0.80) 应为 25.00',
       public.arc_vbt_vl(0.60, 0.80)::text, '25.00'
union all
select '功率(100kg, 0.60m/s) 应为 588.6W',
       public.arc_vbt_power(100, 0.60)::text, '588.6'
union all
select 'lnRMSSD(64) 应为 4.1589',
       public.arc_hrv_lnrmssd(64)::text, '4.1589'
union all
select '睡眠效率(450, 500) 应为 90.0',
       public.arc_sleep_efficiency(450, 500)::text, '90.0'
union all
select '就绪度缺 HRV 仍可算（coverage 0.65）',
       (public.arc_readiness_score(1.0, null, null, null, 480) ->> 'coverage'), '0.65'
union all
select '就绪度全缺不给分（score 为 null）',
       coalesce((public.arc_readiness_score(null, null, null, null, null) ->> 'score'), 'null'), 'null'
union all
select 'ACWR 1.6 触发急增标记',
       (public.arc_readiness_score(1.6, 4.16, 4.16, 0.1, 480) -> 'flags' ->> 0), '负荷急增（ACWR 1.60 > 1.5）'
union all
select '新增派生指标（应为 6）',
       (select count(*)::text from public.metric_registry
         where metric_id in ('readiness','hrv.baseline','hrv.swc','hrv.z','sleep.debt','load.week')), '6'
union all
select '派生触发器（应为 3）',
       (select count(*)::text from pg_trigger
         where tgname in ('trg_jump_before','trg_jump_metrics','trg_vbt_metrics') and not tgisinternal), '3'
union all
select 'anon 可执行的计算类 RPC（应为 0）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'arc\_%'
           and has_function_privilege('anon', p.oid, 'EXECUTE')), '0'
union all
select '导出函数为 invoker（非 definer）',
       (select prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'arc_export_my_data'), 'false';

commit;
