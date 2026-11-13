-- ============================================================================
-- 第三世界 · 0007 周期计划 / 课库 / 规则版本
--
-- 为什么这一版必须有：docs/09 第五节承认「库里没有 plan_blocks / rules」，
-- 于是「周期计划」「课库」「规则版本」三页只能放静态示例——那是这轮最后一块
-- 结构性缺口。这个迁移把三者的**可写模型**补齐，并且：
--
--   · 一份计划挂一个人（athlete）或一支队（team），不自造第三种归属
--   · 周期块按「周」切（week_index），目标负荷写成区间，便于事后比对实际
--   · 课库是模板（session_templates + session_items），排课是
--     session_assignments（模板 → 某人某天），完成后挂 activity_id
--   · 规则版本是**带版本号的阈值快照**（jsonb payload），同一组织只能有一个
--     生效版本（partial unique index），换版本是「改 is_active」的原子动作
--
-- 仍然遵守的老规矩：
--   · 所有租户表带 org_id，RLS 第一层按 org 过滤，第二层按「能不能看这个人」
--   · 客户端不写 audit_logs，统一由触发器 arc_audit_row() 落
--   · 脚本自身幂等（if not exists / drop policy if exists），可重复执行
-- ============================================================================

begin;

-- ── 0. 范围判定：一个人 / 一支队 / 整个组织 ─────────────────────────────────
-- 这三种归属在计划、课、排课里反复出现，抽成两个函数，避免六张表各写一遍策略。
create or replace function public.arc_can_read_scope(
  p_org uuid, p_team uuid default null, p_athlete uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_athlete is not null then public.can_read_athlete(p_athlete)
    else exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id  = p_org
        and (m.expires_at is null or m.expires_at > now())
        and (m.team_id is null or p_team is null or m.team_id = p_team)
    )
  end;
$$;

create or replace function public.arc_can_edit_scope(
  p_org uuid, p_team uuid default null, p_athlete uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_athlete is not null then public.can_write_athlete(p_athlete)
    else exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id  = p_org
        and m.role in ('coach','team_admin','org_admin')
        and (m.expires_at is null or m.expires_at > now())
        and (m.team_id is null or p_team is null or m.team_id = p_team)
    )
  end;
$$;

revoke all on function public.arc_can_read_scope(uuid, uuid, uuid) from public, anon;
revoke all on function public.arc_can_edit_scope(uuid, uuid, uuid) from public, anon;
grant execute on function public.arc_can_read_scope(uuid, uuid, uuid) to authenticated;
grant execute on function public.arc_can_edit_scope(uuid, uuid, uuid) to authenticated;

-- ── 1. 周期计划 ─────────────────────────────────────────────────────────────
create table if not exists public.plan_cycles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete set null,
  athlete_id uuid references public.athletes(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 120),
  goal       text check (goal is null or length(goal) <= 200),
  start_date date not null,
  end_date   date not null,
  phase      text not null default 'base'
             check (phase in ('recovery','base','build','peak','taper')),
  status     text not null default 'draft'
             check (status in ('draft','active','archived')),
  notes      text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 400)
);
create index if not exists idx_plan_cycles_org_status on public.plan_cycles (org_id, status, start_date desc);
create index if not exists idx_plan_cycles_athlete    on public.plan_cycles (athlete_id, start_date desc);
create index if not exists idx_plan_cycles_team       on public.plan_cycles (team_id);
create index if not exists idx_plan_cycles_created_by on public.plan_cycles (created_by);
create trigger trg_plan_cycles_touch before update on public.plan_cycles
  for each row execute function public.touch_updated_at();

comment on table public.plan_cycles is
  '周期计划。athlete_id 非空=个人计划；为空则由 team_id 决定归属（team_id 也为空=组织级）。三者都不填等于没有归属，插入时被 RPC 拒绝。';

-- ── 2. 周期块（按周）────────────────────────────────────────────────────────
create table if not exists public.plan_blocks (
  id              uuid primary key default gen_random_uuid(),
  cycle_id        uuid not null references public.plan_cycles(id) on delete cascade,
  org_id          uuid not null references public.orgs(id) on delete cascade,
  week_index      smallint not null check (week_index between 1 and 60),
  start_date      date not null,
  end_date        date not null,
  focus           text check (focus is null or length(focus) <= 120),
  target_load_min numeric(8,2) check (target_load_min is null or target_load_min >= 0),
  target_load_max numeric(8,2) check (target_load_max is null or target_load_max >= 0),
  notes           text,
  created_at      timestamptz not null default now(),
  unique (cycle_id, week_index),
  check (end_date >= start_date),
  check (target_load_max is null or target_load_min is null or target_load_max >= target_load_min)
);
create index if not exists idx_plan_blocks_cycle on public.plan_blocks (cycle_id, week_index);
create index if not exists idx_plan_blocks_org   on public.plan_blocks (org_id);

comment on column public.plan_blocks.target_load_max is
  '负荷区间上限，单位 AU（与 tl.srpe 同口径）。实际值由 arc_cycle_progress() 汇总对比，不在本表冗余。';

-- ── 3. 课库（模板 + 条目）──────────────────────────────────────────────────
create table if not exists public.session_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 120),
  purpose       text not null default 'strength'
                check (purpose in ('strength','power','speed','conditioning','recovery','skill','test','other')),
  duration_min  smallint check (duration_min is null or duration_min between 1 and 600),
  intensity_rpe smallint check (intensity_rpe is null or intensity_rpe between 1 and 10),
  level         text check (level is null or level in ('beginner','intermediate','advanced')),
  tags          text[] not null default '{}',
  notes         text,
  is_shared     boolean not null default true,
  created_by    uuid references public.app_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_session_templates_org on public.session_templates (org_id, purpose);
create index if not exists idx_session_templates_creator on public.session_templates (created_by);
create trigger trg_session_templates_touch before update on public.session_templates
  for each row execute function public.touch_updated_at();

create table if not exists public.session_items (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.session_templates(id) on delete cascade,
  org_id      uuid not null references public.orgs(id) on delete cascade,
  seq         smallint not null check (seq between 1 and 99),
  exercise    text not null check (length(btrim(exercise)) between 1 and 80),
  sets        smallint check (sets is null or sets between 1 and 30),
  reps        smallint check (reps is null or reps between 1 and 200),
  load_kg     numeric(6,2) check (load_kg is null or load_kg between 0 and 500),
  pct_1rm     smallint check (pct_1rm is null or pct_1rm between 10 and 100),
  distance_m  numeric(8,1) check (distance_m is null or distance_m between 0 and 50000),
  duration_s  integer check (duration_s is null or duration_s between 0 and 86400),
  rest_s      smallint check (rest_s is null or rest_s between 0 and 900),
  vel_min     numeric(4,2) check (vel_min is null or vel_min between 0.1 and 3.0),
  note        text,
  unique (template_id, seq),
  constraint session_items_load_xor_pct check (load_kg is null or pct_1rm is null)   -- 绝对重量与 %1RM 二选一，不混填
);
create index if not exists idx_session_items_template on public.session_items (template_id, seq);
create index if not exists idx_session_items_org      on public.session_items (org_id);

comment on column public.session_items.vel_min is
  'VBT 目标最低速度（m/s）。填了才会在采集时提示「掉速」，没填就不猜。';
comment on constraint session_items_load_xor_pct on public.session_items is
  'load_kg 与 pct_1rm 互斥：两者同时给会让「按 1RM 百分比换算」和「按绝对重量」出现两个事实源。';

-- ── 4. 排课（模板 → 某人某天）──────────────────────────────────────────────
create table if not exists public.session_assignments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  athlete_id     uuid not null references public.athletes(id) on delete cascade,
  template_id    uuid references public.session_templates(id) on delete set null,
  scheduled_date date not null,
  status         text not null default 'planned'
                 check (status in ('planned','done','skipped')),
  activity_id    uuid references public.activities(id) on delete set null,
  planned_load   numeric(8,2) check (planned_load is null or planned_load >= 0),
  note           text,
  created_by     uuid references public.app_users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_session_assignments_athlete
  on public.session_assignments (athlete_id, scheduled_date desc);
create index if not exists idx_session_assignments_org
  on public.session_assignments (org_id, scheduled_date desc);
create index if not exists idx_session_assignments_template on public.session_assignments (template_id);
create index if not exists idx_session_assignments_activity on public.session_assignments (activity_id);
create index if not exists idx_session_assignments_created_by on public.session_assignments (created_by);
create trigger trg_session_assignments_touch before update on public.session_assignments
  for each row execute function public.touch_updated_at();

comment on column public.session_assignments.activity_id is
  '「计划 → 实际」的钩子：完成时挂上真实训练，指标由 activities 触发器重算，不在排课上另算一份。';

-- ── 5. 规则版本（阈值快照）─────────────────────────────────────────────────
create table if not exists public.rules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  version        text not null check (version ~ '^v[0-9]+(\.[0-9]+){1,2}$'),
  name           text not null check (length(btrim(name)) between 1 and 120),
  payload        jsonb not null,
  effective_from date not null default current_date,
  is_active      boolean not null default false,
  created_by     uuid references public.app_users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (org_id, version)
);
create unique index if not exists rules_one_active on public.rules (org_id) where is_active;
create index if not exists idx_rules_org on public.rules (org_id, effective_from desc);
create index if not exists idx_rules_created_by on public.rules (created_by);

comment on table public.rules is
  '规则版本：阈值不再硬编码在函数里，而是以版本化 jsonb 落库。arc_active_rule() 取生效版本；缺失时用内置默认值，不报错。';

-- ── 6. RLS ─────────────────────────────────────────────────────────────────
alter table public.plan_cycles         enable row level security;
alter table public.plan_blocks         enable row level security;
alter table public.session_templates   enable row level security;
alter table public.session_items       enable row level security;
alter table public.session_assignments enable row level security;
alter table public.rules               enable row level security;

drop policy if exists plan_cycles_select on public.plan_cycles;
create policy plan_cycles_select on public.plan_cycles
  for select to authenticated
  using (public.arc_can_read_scope(org_id, team_id, athlete_id));
drop policy if exists plan_cycles_write on public.plan_cycles;
create policy plan_cycles_write on public.plan_cycles
  for all to authenticated
  using (public.arc_can_edit_scope(org_id, team_id, athlete_id))
  with check (public.arc_can_edit_scope(org_id, team_id, athlete_id));

drop policy if exists plan_blocks_select on public.plan_blocks;
create policy plan_blocks_select on public.plan_blocks
  for select to authenticated
  using (exists (select 1 from public.plan_cycles c where c.id = cycle_id));
drop policy if exists plan_blocks_write on public.plan_blocks;
create policy plan_blocks_write on public.plan_blocks
  for all to authenticated
  using (public.arc_can_edit_scope(org_id,
           (select c.team_id from public.plan_cycles c where c.id = cycle_id),
           (select c.athlete_id from public.plan_cycles c where c.id = cycle_id)))
  with check (public.arc_can_edit_scope(org_id,
           (select c.team_id from public.plan_cycles c where c.id = cycle_id),
           (select c.athlete_id from public.plan_cycles c where c.id = cycle_id)));

drop policy if exists session_templates_select on public.session_templates;
create policy session_templates_select on public.session_templates
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists session_templates_write on public.session_templates;
create policy session_templates_write on public.session_templates
  for all to authenticated
  using (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]));

drop policy if exists session_items_select on public.session_items;
create policy session_items_select on public.session_items
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists session_items_write on public.session_items;
create policy session_items_write on public.session_items
  for all to authenticated
  using (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]));

drop policy if exists session_assignments_select on public.session_assignments;
create policy session_assignments_select on public.session_assignments
  for select to authenticated using (public.can_read_athlete(athlete_id));
drop policy if exists session_assignments_write on public.session_assignments;
create policy session_assignments_write on public.session_assignments
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

drop policy if exists rules_select on public.rules;
create policy rules_select on public.rules
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists rules_write on public.rules;
create policy rules_write on public.rules
  for all to authenticated
  using (public.is_org_member(org_id, array['org_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['org_admin']::app_role[]));

-- ── 7. 审计：与 activities 同一条通道，客户端不可自报 ─────────────────────
drop trigger if exists trg_audit_plan_cycles on public.plan_cycles;
create trigger trg_audit_plan_cycles
  after insert or update or delete on public.plan_cycles
  for each row execute function public.arc_audit_row();

drop trigger if exists trg_audit_session_templates on public.session_templates;
create trigger trg_audit_session_templates
  after insert or update or delete on public.session_templates
  for each row execute function public.arc_audit_row();

drop trigger if exists trg_audit_session_assignments on public.session_assignments;
create trigger trg_audit_session_assignments
  after insert or update or delete on public.session_assignments
  for each row execute function public.arc_audit_row();

drop trigger if exists trg_audit_rules on public.rules;
create trigger trg_audit_rules
  after insert or update or delete on public.rules
  for each row execute function public.arc_audit_row();

-- ══════════════════════════════════════════════════════════════════════════
-- 8. 规则默认值 + 生效版本读取
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_default_rule_payload()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'acwr', jsonb_build_object('low', 0.8, 'high', 1.3, 'danger', 1.5),
    'monotony_max', 2.0,
    'strain_max', 6000,
    'readiness', jsonb_build_object('acwr_w', 0.35, 'hrv_w', 0.35, 'sleep_w', 0.30, 'swc_k', 0.5),
    'sleep', jsonb_build_object('target_min', 480, 'deficit_warn_min', 300),
    'vbt', jsonb_build_object('velocity_1rm', 0.3, 'vl_warn_pct', 20),
    'jump', jsonb_build_object('asym_warn_pct', 10),
    'windows', jsonb_build_object('acute_days', 7, 'chronic_days', 28, 'baseline_days', 7),
    'data', jsonb_build_object('min_valid_days', 7, 'partial_ratio', 0.8)
  );
$$;

create or replace function public.arc_active_rule(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select r.payload from public.rules r
      where r.org_id = p_org and r.is_active
      order by r.effective_from desc limit 1),
    public.arc_default_rule_payload()
  );
$$;

create or replace function public.arc_seed_default_rules(p_org uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := coalesce(p_org, (select m.org_id from public.memberships m
                                 where m.user_id = auth.uid()
                                 order by m.granted_at limit 1));
  v_id uuid;
begin
  if v_org is null then
    raise exception '没有可用的组织' using errcode = 'P0002';
  end if;
  if not public.is_org_member(v_org, array['org_admin']::app_role[]) then
    raise exception '只有组织管理员可以设定规则版本' using errcode = '42501';
  end if;

  insert into public.rules (org_id, version, name, payload, is_active, created_by)
  values (v_org, 'v1.0', '默认口径 v1.0', public.arc_default_rule_payload(), true, auth.uid())
  on conflict (org_id, version) do nothing;

  select id into v_id from public.rules where org_id = v_org and version = 'v1.0';
  return v_id;
end;
$$;

create or replace function public.arc_activate_rule(p_rule uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.rules where id = p_rule;
  if v_org is null then
    raise exception '规则版本不存在' using errcode = 'P0002';
  end if;
  if not public.is_org_member(v_org, array['org_admin']::app_role[]) then
    raise exception '只有组织管理员可以切换规则版本' using errcode = '42501';
  end if;

  -- 同一组织只能有一个生效版本：先关全部再开一个（同一事务内，唯一索引不会打架）
  update public.rules set is_active = false where org_id = v_org and is_active and id <> p_rule;
  update public.rules set is_active = true  where id = p_rule;

  insert into public.audit_logs (actor_id, org_id, action, target_type, target_id, detail)
  values (auth.uid(), v_org, 'rule.activate', 'rules', p_rule::text, '{}'::jsonb);
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. 排课与「本周计划」
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_assign_session(
  p_athlete  uuid,
  p_template uuid,
  p_date     date default null,
  p_note     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_id  uuid;
  v_d   date := coalesce(p_date, current_date);
begin
  if not public.can_write_athlete(p_athlete) then
    raise exception '无权给该运动员排课' using errcode = '42501';
  end if;

  select org_id into v_org from public.athletes where id = p_athlete;

  if p_template is not null and not exists (
    select 1 from public.session_templates t where t.id = p_template and t.org_id = v_org
  ) then
    raise exception '课库模板不属于该组织' using errcode = '42501';
  end if;

  insert into public.session_assignments (org_id, athlete_id, template_id, scheduled_date, note, created_by)
  values (v_org, p_athlete, p_template, v_d, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.session_assignments
    where athlete_id = p_athlete and scheduled_date = v_d
      and template_id is not distinct from p_template
    order by created_at desc limit 1;
  end if;

  return v_id;
end;
$$;

create or replace function public.arc_week_plan(
  p_athlete uuid,
  p_any_date date default null
)
returns table (
  assignment_id  uuid,
  scheduled_date date,
  status         text,
  title          text,
  purpose        text,
  duration_min   smallint,
  intensity_rpe  smallint,
  template_id    uuid,
  note           text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with w as (
    select (date_trunc('week', coalesce(p_any_date, current_date)::timestamp))::date as mon
  )
  select a.id, a.scheduled_date, a.status,
         t.title, t.purpose, t.duration_min, t.intensity_rpe,
         a.template_id, coalesce(a.note, t.notes)
  from public.session_assignments a
  left join public.session_templates t on t.id = a.template_id
  cross join w
  where a.athlete_id = p_athlete
    and a.scheduled_date between w.mon and w.mon + 6
    and public.can_read_athlete(p_athlete)
  order by a.scheduled_date, a.created_at;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- 10. 计划执行度：计划 vs 实际（不改表，只聚合）
--     实际负荷一律取 activities.training_load（唯一事实源），不另算求和。
-- ══════════════════════════════════════════════════════════════════════════
create or replace function public.arc_cycle_progress(p_cycle uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c          public.plan_cycles%rowtype;
  v_tz       text;
  v_planned  integer;
  v_done     integer;
  v_skipped  integer;
  v_plan_ld  numeric;
  v_act_ld   numeric;
  v_act_n    integer;
  v_athletes integer;
  v_weeks    jsonb;
begin
  select * into c from public.plan_cycles where id = p_cycle;
  if c.id is null then
    raise exception '计划不存在' using errcode = 'P0002';
  end if;
  if not public.arc_can_read_scope(c.org_id, c.team_id, c.athlete_id) then
    raise exception '无权查看该计划' using errcode = '42501';
  end if;

  select coalesce(o.timezone, 'Asia/Shanghai') into v_tz
  from public.orgs o where o.id = c.org_id;

  select count(*),
         count(*) filter (where a.status = 'done'),
         count(*) filter (where a.status = 'skipped'),
         coalesce(sum(a.planned_load), 0)
    into v_planned, v_done, v_skipped, v_plan_ld
  from public.session_assignments a
  where a.org_id = c.org_id
    and (c.athlete_id is null or a.athlete_id = c.athlete_id)
    and a.scheduled_date between c.start_date and c.end_date;

  select count(*), coalesce(sum(s.training_load), 0) into v_act_n, v_act_ld
  from public.activities s
  join public.athletes ath on ath.id = s.athlete_id
  where s.org_id = c.org_id
    and (c.athlete_id is null or s.athlete_id = c.athlete_id)
    and (c.athlete_id is not null or c.team_id is null or ath.team_id = c.team_id)
    and (s.started_at at time zone v_tz)::date between c.start_date and c.end_date;

  select count(*) into v_athletes
  from public.athletes ath
  where ath.org_id = c.org_id
    and ath.status = 'active'
    and (c.athlete_id is null or ath.id = c.athlete_id)
    and (c.athlete_id is not null or c.team_id is null or ath.team_id = c.team_id);

  select coalesce(jsonb_agg(x order by x.week_index), '[]'::jsonb) into v_weeks
  from (
    select b.week_index,
           b.start_date, b.end_date, b.focus,
           b.target_load_min, b.target_load_max,
           coalesce((
             select sum(s.training_load) from public.activities s
             join public.athletes ath on ath.id = s.athlete_id
             where s.org_id = c.org_id
               and (c.athlete_id is null or s.athlete_id = c.athlete_id)
               and (c.athlete_id is not null or c.team_id is null or ath.team_id = c.team_id)
               and (s.started_at at time zone v_tz)::date between b.start_date and b.end_date
           ), 0) as actual_load
    from public.plan_blocks b
    where b.cycle_id = c.id
  ) x;

  return jsonb_build_object(
    'cycle_id', c.id,
    'name', c.name,
    'phase', c.phase,
    'status', c.status,
    'start_date', c.start_date,
    'end_date', c.end_date,
    'athletes', v_athletes,
    'assignments', jsonb_build_object('planned', v_planned, 'done', v_done, 'skipped', v_skipped,
      'adherence', case when v_planned > 0 then round(v_done::numeric / v_planned, 3) else null end),
    'load', jsonb_build_object('planned', v_plan_ld, 'actual', round(v_act_ld, 2),
      'ratio', case when v_plan_ld > 0 then round(v_act_ld / v_plan_ld, 3) else null end,
      'sessions', v_act_n),
    'weeks', v_weeks
  );
end;
$$;

-- ── 11. 授权收口 ───────────────────────────────────────────────────────────
revoke all on function public.arc_default_rule_payload()           from public, anon;
revoke all on function public.arc_active_rule(uuid)                from public, anon;
revoke all on function public.arc_seed_default_rules(uuid)         from public, anon;
revoke all on function public.arc_activate_rule(uuid)              from public, anon;
revoke all on function public.arc_assign_session(uuid, uuid, date, text) from public, anon;
revoke all on function public.arc_week_plan(uuid, date)            from public, anon;
revoke all on function public.arc_cycle_progress(uuid)             from public, anon;

grant execute on function public.arc_default_rule_payload()           to authenticated;
grant execute on function public.arc_active_rule(uuid)                to authenticated;
grant execute on function public.arc_seed_default_rules(uuid)         to authenticated;
grant execute on function public.arc_activate_rule(uuid)              to authenticated;
grant execute on function public.arc_assign_session(uuid, uuid, date, text) to authenticated;
grant execute on function public.arc_week_plan(uuid, date)            to authenticated;
grant execute on function public.arc_cycle_progress(uuid)             to authenticated;

-- ── 12. 自检 ───────────────────────────────────────────────────────────────
select '新增业务表（应为 6）'::text as item,
       (select count(*)::text from information_schema.tables
         where table_schema = 'public'
           and table_name in ('plan_cycles','plan_blocks','session_templates',
                              'session_items','session_assignments','rules')), '6'::text as expect
union all
select '新增表均启用 RLS',
       (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('plan_cycles','plan_blocks','session_templates',
                             'session_items','session_assignments','rules')
           and c.relrowsecurity), '6'
union all
select '新增表均无 anon DML 权限',
       (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('plan_cycles','plan_blocks','session_templates',
                             'session_items','session_assignments','rules')
           and not has_table_privilege('anon', c.oid, 'INSERT')), '6'
union all
select '同一组织仅一个生效规则版本',
       (select count(*)::text from pg_indexes where schemaname = 'public' and indexname = 'rules_one_active'), '1'
union all
select '新增审计触发器（应为 4）',
       (select count(*)::text from pg_trigger
         where tgname in ('trg_audit_plan_cycles','trg_audit_session_templates',
                          'trg_audit_session_assignments','trg_audit_rules') and not tgisinternal), '4'
union all
select '计划/课库 RPC（应为 7）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in
           ('arc_default_rule_payload','arc_active_rule','arc_seed_default_rules','arc_activate_rule',
            'arc_assign_session','arc_week_plan','arc_cycle_progress')), '7'
union all
select 'anon 可执行的计划类 RPC（应为 0）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'arc\_%'
           and has_function_privilege('anon', p.oid, 'EXECUTE')), '0'
union all
select '业务表总数（0006 之后 18 + 6）',
       (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition), '24';

commit;
