-- 第三世界 · 0006 真实用户可注册 / 可登录 / 可记录 / 可计算
--
-- 这一版解决 0001-0005 里「看起来有权限，实际走不通」的四处死锁：
--
--   ① orgs 只有 SELECT / UPDATE，没有 INSERT → 任何新用户都建不了组织。
--   ② memberships 的 INSERT 要求 is_org_member(org_id, ['org_admin'])
--      → 第一个 org_admin 永远建不出来（先有鸡还是先有蛋）。
--   ③ athletes 的 INSERT 要求 coach/team_admin/org_admin 身份
--      → 运动员自己注册后无法建立自己的档案行。
--   ④ audit_logs 允许 authenticated 直接 INSERT（actor_id = auth.uid()）
--      → 审计是「客户端自报」，可以伪造任意 action，审计等于没有。
--
-- 处理原则：
--   - 需要跨权限边界、且必须一次成功的多表写入，一律收进 security definer RPC，
--     由 RPC 内部做参数校验 + 身份校验，不给客户端开宽策略。
--   - 审计改为触发器写入（客户端已无权插入），记录真实 actor。
--   - 负载与派生指标在服务端算，写回 daily_metrics；客户端只读不算，
--     避免「前端算一套、库里另一套」。
--   - 全部语句幂等，可重复执行。

begin;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. 邀请码（不依赖邮件 / 短信，不产生第三方费用）
-- ══════════════════════════════════════════════════════════════════════════
create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete set null,
  role        app_role not null default 'athlete',
  code        text not null unique,
  created_by  uuid references public.app_users(id) on delete set null,
  expires_at  timestamptz,
  max_uses    integer not null default 1,
  used_count  integer not null default 0,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint invites_code_ck   check (char_length(code) between 6 and 16),
  constraint invites_uses_ck    check (max_uses between 1 and 500 and used_count >= 0),
  -- 邀请码不允许直接产生组织管理员：提权只能由组织内现有 org_admin 在成员页操作
  constraint invites_role_ck    check (role <> 'org_admin')
);

create index if not exists idx_invites_org on public.invites(org_id, created_at desc);
create index if not exists idx_invites_code on public.invites(upper(code));
-- 外键列必须有索引，否则组织注销/成员删除时父行要全表扫（核查项 A 会报）
create index if not exists idx_invites_team on public.invites(team_id);
create index if not exists idx_invites_created_by on public.invites(created_by);

alter table public.invites enable row level security;

drop policy if exists invites_select_admin on public.invites;
create policy invites_select_admin on public.invites
  for select to authenticated
  using (is_org_member(org_id, array['org_admin'::app_role, 'team_admin'::app_role]));

drop policy if exists invites_write_admin on public.invites;
create policy invites_write_admin on public.invites
  for all to authenticated
  using (is_org_member(org_id, array['org_admin'::app_role, 'team_admin'::app_role]))
  with check (is_org_member(org_id, array['org_admin'::app_role, 'team_admin'::app_role]));

comment on table public.invites is
  '团队邀请码。兑换必须走 arc_redeem_invite()（security definer），客户端不能直接读别人的码。';

-- 随机码：去掉 0/O/1/I 等易混字符
create or replace function public.arc_random_code()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                           (floor(random() * 32) + 1)::int, 1), '')
  from generate_series(1, 8);
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 开通流程 RPC
-- ══════════════════════════════════════════════════════════════════════════
-- 2.1 教练 / 机构：建组织 + 默认队 + 自己成为 org_admin（可选同时建自己的运动员档案）
create or replace function public.arc_bootstrap_org(
  p_org_name      text,
  p_display_name  text default null,
  p_also_athlete  boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_team  uuid;
  v_name  text;
  v_slug  text;
begin
  if v_uid is null then
    raise exception '未登录' using errcode = '28000';
  end if;
  if exists (select 1 from public.memberships m
              where m.user_id = v_uid and (m.expires_at is null or m.expires_at > now())) then
    raise exception '该账号已在组织中，不能重复创建' using errcode = '23505';
  end if;

  p_org_name := btrim(coalesce(p_org_name, ''));
  if char_length(p_org_name) < 2 or char_length(p_org_name) > 60 then
    raise exception '组织名称需 2–60 个字符' using errcode = '22023';
  end if;

  insert into public.app_users (id, display_name)
  values (v_uid, nullif(btrim(coalesce(p_display_name, '')), ''))
  on conflict (id) do update
    set display_name = coalesce(nullif(btrim(excluded.display_name), ''), public.app_users.display_name);

  select display_name into v_name from public.app_users where id = v_uid;
  v_slug := 'org-' || substr(replace(v_uid::text, '-', ''), 1, 12);

  insert into public.orgs (name, slug) values (p_org_name, v_slug) returning id into v_org;
  insert into public.teams (org_id, name) values (v_org, '一队') returning id into v_team;

  insert into public.memberships (org_id, team_id, user_id, role, granted_by)
  values (v_org, null, v_uid, 'org_admin', v_uid);

  if coalesce(p_also_athlete, true) then
    insert into public.athletes (org_id, team_id, user_id, full_name)
    values (v_org, v_team, v_uid, coalesce(v_name, '我'));
  end if;

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, v_org, 'org.bootstrap', 'org', v_org::text,
          jsonb_build_object('org_name', p_org_name, 'also_athlete', coalesce(p_also_athlete, true)));

  return v_org;
end;
$$;

-- 2.2 运动员个人：建个人空间（org + 自己 + 自己的运动员档案）
create or replace function public.arc_join_solo(p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_team  uuid;
  v_name  text;
begin
  if v_uid is null then
    raise exception '未登录' using errcode = '28000';
  end if;
  if exists (select 1 from public.memberships m
              where m.user_id = v_uid and (m.expires_at is null or m.expires_at > now())) then
    raise exception '该账号已在组织中，不能重复创建' using errcode = '23505';
  end if;

  insert into public.app_users (id, display_name)
  values (v_uid, nullif(btrim(coalesce(p_display_name, '')), ''))
  on conflict (id) do update
    set display_name = coalesce(nullif(btrim(excluded.display_name), ''), public.app_users.display_name);

  select display_name into v_name from public.app_users where id = v_uid;
  v_name := coalesce(v_name, '我');

  insert into public.orgs (name, slug)
  values (left(v_name, 50) || ' 的个人空间', 'solo-' || substr(replace(v_uid::text, '-', ''), 1, 12))
  returning id into v_org;

  insert into public.teams (org_id, name) values (v_org, '个人') returning id into v_team;

  insert into public.memberships (org_id, team_id, user_id, role, granted_by)
  values (v_org, null, v_uid, 'athlete', v_uid);

  insert into public.athletes (org_id, team_id, user_id, full_name)
  values (v_org, v_team, v_uid, v_name);

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, v_org, 'org.solo', 'org', v_org::text, jsonb_build_object('display_name', v_name));

  return v_org;
end;
$$;

-- 2.3 教练发邀请码（team_admin 只能发本队的）
create or replace function public.arc_create_invite(
  p_role       text default 'athlete',
  p_team_id    uuid default null,
  p_max_uses   integer default 1,
  p_days       integer default 14
)
returns table (code text, org_id uuid, team_id uuid, role app_role, expires_at timestamptz, max_uses integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_role  app_role;
  v_team  uuid := p_team_id;
  v_code  text;
  v_exp   timestamptz;
  v_my    record;
begin
  if v_uid is null then raise exception '未登录' using errcode = '28000'; end if;

  begin
    v_role := p_role::app_role;
  exception when others then
    raise exception '角色不合法：%', p_role using errcode = '22023';
  end;

  if v_role = 'org_admin' then
    raise exception '不能通过邀请码授予组织管理员' using errcode = '42501';
  end if;

  -- 取我权限最高的那条成员关系
  select m.org_id, m.team_id, m.role into v_my
  from public.memberships m
  where m.user_id = v_uid
    and (m.expires_at is null or m.expires_at > now())
    and m.role in ('org_admin', 'team_admin')
  order by case m.role when 'org_admin' then 0 else 1 end
  limit 1;

  if not found then
    raise exception '只有组织管理员或主教练可以发邀请码' using errcode = '42501';
  end if;

  v_org := v_my.org_id;
  if v_my.role = 'team_admin' then
    v_team := v_my.team_id;           -- 主教练不能跨队发码
  end if;

  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 500 then
    raise exception '可用次数需在 1–500 之间' using errcode = '22023';
  end if;
  v_exp := now() + make_interval(days => greatest(1, least(coalesce(p_days, 14), 90)));

  v_code := public.arc_random_code();
  while exists (select 1 from public.invites i where i.code = v_code) loop
    v_code := public.arc_random_code();
  end loop;

  insert into public.invites (org_id, team_id, role, code, created_by, expires_at, max_uses)
  values (v_org, v_team, v_role, v_code, v_uid, v_exp, p_max_uses);

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, v_org, 'invite.create', 'invite', v_code,
          jsonb_build_object('role', v_role, 'max_uses', p_max_uses, 'team_id', v_team));

  return query select v_code, v_org, v_team, v_role, v_exp, p_max_uses;
end;
$$;

-- 2.4 兑换邀请码（原子：加成员 + 必要时建运动员档案 + 计数）
create or replace function public.arc_redeem_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_inv   public.invites;
  v_name  text;
begin
  if v_uid is null then raise exception '未登录' using errcode = '28000'; end if;
  if coalesce(btrim(p_code), '') = '' then
    raise exception '请输入邀请码' using errcode = '22023';
  end if;

  select * into v_inv from public.invites i
   where upper(i.code) = upper(btrim(p_code))
   for update;

  if not found then
    raise exception '邀请码不存在' using errcode = 'P0002';
  end if;
  if v_inv.revoked_at is not null then
    raise exception '该邀请码已被撤销' using errcode = '22023';
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    raise exception '该邀请码已过期' using errcode = '22023';
  end if;
  if v_inv.used_count >= v_inv.max_uses then
    raise exception '该邀请码已用尽' using errcode = '22023';
  end if;

  -- 幂等：同一人重复兑换同一组织，直接返回，不重复计数
  if exists (select 1 from public.memberships m
              where m.user_id = v_uid and m.org_id = v_inv.org_id) then
    return v_inv.org_id;
  end if;

  -- 一个账号只归属一个组织（跨组织需要在成员页显式退出）
  if exists (select 1 from public.memberships m
              where m.user_id = v_uid and (m.expires_at is null or m.expires_at > now())) then
    raise exception '该账号已属于其他组织，请先退出当前组织' using errcode = '23505';
  end if;

  insert into public.app_users (id, display_name)
  values (v_uid, null)
  on conflict (id) do nothing;

  insert into public.memberships (org_id, team_id, user_id, role, granted_by)
  values (v_inv.org_id, v_inv.team_id, v_uid, v_inv.role, v_inv.created_by);

  if v_inv.role = 'athlete' then
    select display_name into v_name from public.app_users where id = v_uid;
    if not exists (select 1 from public.athletes a where a.user_id = v_uid and a.org_id = v_inv.org_id) then
      insert into public.athletes (org_id, team_id, user_id, full_name)
      values (v_inv.org_id, v_inv.team_id, v_uid, coalesce(v_name, '新成员'));
    end if;
  end if;

  update public.invites set used_count = used_count + 1 where id = v_inv.id;

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, v_inv.org_id, 'invite.redeem', 'invite', v_inv.code,
          jsonb_build_object('role', v_inv.role));

  return v_inv.org_id;
end;
$$;

-- 2.5 教练新建运动员档案（不给客户端开宽 INSERT 策略）
create or replace function public.arc_add_athlete(
  p_full_name text,
  p_team_id   uuid default null,
  p_sex       text default null,
  p_birth     date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_my  record;
  v_id  uuid;
  v_sex sex_at_birth;
begin
  if v_uid is null then raise exception '未登录' using errcode = '28000'; end if;
  if coalesce(btrim(p_full_name), '') = '' then
    raise exception '姓名不能为空' using errcode = '22023';
  end if;
  if char_length(btrim(p_full_name)) > 40 then
    raise exception '姓名过长' using errcode = '22023';
  end if;

  select m.org_id, m.team_id, m.role into v_my
  from public.memberships m
  where m.user_id = v_uid and (m.expires_at is null or m.expires_at > now())
    and m.role in ('coach','team_admin','org_admin','clinician')
  order by case m.role when 'org_admin' then 0 when 'team_admin' then 1 else 2 end
  limit 1;

  if not found then
    raise exception '当前角色不能添加成员' using errcode = '42501';
  end if;

  if p_sex is not null and p_sex <> '' then
    begin v_sex := p_sex::sex_at_birth;
    exception when others then raise exception '性别取值不合法' using errcode = '22023'; end;
  end if;

  insert into public.athletes (org_id, team_id, full_name, sex, birth_date)
  values (v_my.org_id,
          coalesce(p_team_id, v_my.team_id),
          btrim(p_full_name), v_sex, p_birth)
  returning id into v_id;

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (v_uid, v_my.org_id, 'athlete.create', 'athlete', v_id::text,
          jsonb_build_object('full_name', btrim(p_full_name)));

  return v_id;
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 服务端指标计算：TL → CTL / ATL / TSB / ACWR(EWMA & rolling) / TM / TS
--    口径与 docs/01 §9、data.js METRICS 完全一致：
--    · 缺测日（当天没有任何 activity）跳过，不补 0，EWMA 保持前值
--    · rolling 需要 7/7 与 ≥26/28 有效天才输出
--    · TM 需 sd > 0，否则不可计算（不写 0、不写 Infinity）
-- ══════════════════════════════════════════════════════════════════════════
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

  if v_start is null then
    return 0;   -- 没有任何训练记录：不写任何指标行（区别于「写了 0」）
  end if;

  for d in select generate_series(v_start, v_to, interval '1 day')::date loop
    select count(*), coalesce(sum(s.training_load), 0) into v_cnt, v_sum
    from public.activities s
    where s.athlete_id = p_athlete
      and (s.started_at at time zone v_tz)::date = d
      and s.training_load is not null;

    if v_cnt = 0 then
      continue;   -- 缺测日：不更新、不落库
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

    v_days := v_days + 1;
  end loop;

  return v_days;
end;
$$;

-- 3.1 写入训练记录后自动重算（失败不阻塞记录本身，但必须留痕）
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
    perform public.arc_recompute_metrics(v_athlete, current_date);
  exception when others then
    insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
    values (auth.uid(), coalesce(new.org_id, old.org_id), 'metrics.recompute.failed',
            'athlete', v_athlete::text, jsonb_build_object('error', sqlerrm, 'state', sqlstate));
  end;
  return null;
end;
$$;

drop trigger if exists trg_activities_metrics on public.activities;
create trigger trg_activities_metrics
  after insert or update of training_load, started_at, athlete_id or delete on public.activities
  for each row execute function public.arc_after_activity();

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 审计改为触发器写入（客户端不得再自报审计）
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  jsonb;
  v_org  uuid;
  v_tid  text;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org := nullif(v_row ->> 'org_id', '')::uuid;
  v_tid := coalesce(v_row ->> 'id', v_row ->> 'session_id', '');

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (auth.uid(), v_org, lower(tg_table_name) || '.' || lower(tg_op), tg_table_name, v_tid,
          jsonb_build_object('op', tg_op));
  return null;
end;
$$;

drop trigger if exists trg_audit_activities on public.activities;
create trigger trg_audit_activities
  after insert or update or delete on public.activities
  for each row execute function public.arc_audit_row();

drop trigger if exists trg_audit_test_sessions on public.test_sessions;
create trigger trg_audit_test_sessions
  after insert or update or delete on public.test_sessions
  for each row execute function public.arc_audit_row();

-- 客户端不再能插入审计（触发器以 definer 身份写入，不受 RLS 限制）
drop policy if exists audit_logs_insert_self on public.audit_logs;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 数据校验：把「明显错误的值」挡在库里，而不是靠前端
-- ══════════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activities_duration_ck') then
    alter table public.activities add constraint activities_duration_ck
      check (duration_s is null or (duration_s > 0 and duration_s <= 86400)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activities_rpe_ck') then
    alter table public.activities add constraint activities_rpe_ck
      check (rpe is null or (rpe >= 0 and rpe <= 10)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activities_load_ck') then
    alter table public.activities add constraint activities_load_ck
      check (training_load is null or (training_load >= 0 and training_load <= 5000)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activities_distance_ck') then
    alter table public.activities add constraint activities_distance_ck
      check (distance_m is null or (distance_m >= 0 and distance_m <= 1000000)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'athletes_height_ck') then
    alter table public.athletes add constraint athletes_height_ck
      check (height_cm is null or (height_cm >= 50 and height_cm <= 260)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'athletes_weight_ck') then
    alter table public.athletes add constraint athletes_weight_ck
      check (weight_kg is null or (weight_kg >= 20 and weight_kg <= 300)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jump_height_ck') then
    alter table public.jump_tests add constraint jump_height_ck
      check (height_cm is null or (height_cm >= 0 and height_cm <= 200)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jump_time_ck') then
    alter table public.jump_tests add constraint jump_time_ck
      check ((contact_ms is null or (contact_ms >= 0 and contact_ms <= 3000))
         and (flight_ms  is null or (flight_ms  >= 0 and flight_ms  <= 3000))) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vbt_load_ck') then
    alter table public.vbt_sets add constraint vbt_load_ck
      check ((load_kg is null or (load_kg >= 0 and load_kg <= 600))
         and (reps    is null or (reps    >= 1 and reps    <= 200))) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vbt_velocity_ck') then
    alter table public.vbt_sets add constraint vbt_velocity_ck
      check ((mcv is null or (mcv >= 0 and mcv <= 10))
         and (mpv is null or (mpv >= 0 and mpv <= 10))
         and (pv  is null or (pv  >= 0 and pv  <= 15))) not valid;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 授权：RPC 只给 authenticated；匿名一律不可执行
-- ══════════════════════════════════════════════════════════════════════════
revoke all on function public.arc_bootstrap_org(text, text, boolean)      from public, anon;
revoke all on function public.arc_join_solo(text)                          from public, anon;
revoke all on function public.arc_create_invite(text, uuid, integer, integer) from public, anon;
revoke all on function public.arc_redeem_invite(text)                      from public, anon;
revoke all on function public.arc_add_athlete(text, uuid, text, date)      from public, anon;
revoke all on function public.arc_recompute_metrics(uuid, date)            from public, anon;
revoke all on function public.arc_random_code()                            from public, anon;
revoke all on function public.arc_audit_row()                              from public, anon;
revoke all on function public.arc_after_activity()                         from public, anon;

grant execute on function public.arc_bootstrap_org(text, text, boolean)      to authenticated;
grant execute on function public.arc_join_solo(text)                          to authenticated;
grant execute on function public.arc_create_invite(text, uuid, integer, integer) to authenticated;
grant execute on function public.arc_redeem_invite(text)                      to authenticated;
grant execute on function public.arc_add_athlete(text, uuid, text, date)      to authenticated;
grant execute on function public.arc_recompute_metrics(uuid, date)            to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 7. 自检
-- ══════════════════════════════════════════════════════════════════════════
select 'invites 表存在'::text as item,
       (select count(*)::text from information_schema.tables
         where table_schema='public' and table_name='invites'), '1'::text as expect
union all
select 'invites 已启用 RLS',
       (select c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname='invites'), 'true'
union all
select '开通类 RPC 数量（应为 6）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname in
           ('arc_bootstrap_org','arc_join_solo','arc_create_invite','arc_redeem_invite',
            'arc_add_athlete','arc_recompute_metrics')), '6'
union all
select 'anon 可执行的开通 RPC（应为 0）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname like 'arc\_%'
           and has_function_privilege('anon', p.oid, 'EXECUTE')), '0'
union all
select 'activities 自动重算触发器',
       (select count(*)::text from pg_trigger where tgname='trg_activities_metrics' and not tgisinternal), '1'
union all
select '审计触发器（activities / test_sessions）',
       (select count(*)::text from pg_trigger where tgname in ('trg_audit_activities','trg_audit_test_sessions') and not tgisinternal), '2'
union all
select 'audit_logs 客户端自报策略（应为 0）',
       (select count(*)::text from pg_policies
         where schemaname='public' and tablename='audit_logs' and policyname='audit_logs_insert_self'), '0'
union all
select 'activities 校验约束数（应为 4）',
       (select count(*)::text from pg_constraint
         where conname in ('activities_duration_ck','activities_rpe_ck','activities_load_ck','activities_distance_ck')), '4'
union all
select '业务表数量（不含分区子表）',
       (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition), '18';

commit;
