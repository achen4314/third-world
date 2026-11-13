-- ============================================================================
-- 第三世界 · 0002 RLS 策略
-- 鉴权模型（与 docs/01 的 RBAC 矩阵一一对应）：
--   身份 = auth.uid()（Supabase Auth）
--   角色 = memberships.role（org 级 team_id IS NULL / team 级 team_id 非空），带 expires_at
--   范围 = 组织 → 队伍 → 单人授权（athlete_grants，只读）
-- 三条硬规则：
--   1. 个人设备 / 训练记录 / 健康指标：只有「能读到这个运动员」的人可读，「能写这个运动员」的人可写
--   2. device_credentials 与 device OAuth 令牌：**不建任何策略** = 默认拒绝，仅 service_role 可访问
--   3. audit_logs 只追加：撤销 authenticated 的 update / delete
-- ============================================================================

-- ── 辅助函数（SECURITY DEFINER，绕开 RLS 以避免策略自引用递归）──────────────
create or replace function public.is_org_member(target_org uuid, roles app_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = auth.uid()
      and m.org_id  = target_org
      and (m.expires_at is null or m.expires_at > now())
      and (roles is null or m.role = any (roles))
  );
$$;

create or replace function public.can_read_athlete(target_athlete uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.athletes a
    where a.id = target_athlete
      and (
        a.user_id = auth.uid()
        or exists (
          select 1 from public.athlete_grants g
          where g.athlete_id = a.id
            and g.user_id = auth.uid()
            and (g.expires_at is null or g.expires_at > now())
        )
        or exists (
          select 1 from public.memberships m
          where m.user_id = auth.uid()
            and m.org_id  = a.org_id
            and (m.expires_at is null or m.expires_at > now())
            and (m.team_id is null or m.team_id = a.team_id)
        )
      )
  );
$$;

create or replace function public.can_write_athlete(target_athlete uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.athletes a
    where a.id = target_athlete
      and (
        a.user_id = auth.uid()
        or exists (
          select 1 from public.memberships m
          where m.user_id = auth.uid()
            and m.org_id  = a.org_id
            and m.role in ('coach','team_admin','org_admin','clinician')
            and (m.expires_at is null or m.expires_at > now())
            and (m.team_id is null or m.team_id = a.team_id)
        )
      )
  );
$$;

create or replace function public.shares_org_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships me
    join public.memberships them on them.org_id = me.org_id
    where me.user_id = auth.uid()
      and them.user_id = other_user
      and me.role in ('org_admin','team_admin','coach','analyst','clinician')
      and (me.expires_at is null or me.expires_at > now())
      and (them.expires_at is null or them.expires_at > now())
  );
$$;

revoke all on function public.is_org_member(uuid, app_role[])  from public, anon;
revoke all on function public.can_read_athlete(uuid)          from public, anon;
revoke all on function public.can_write_athlete(uuid)         from public, anon;
revoke all on function public.shares_org_with(uuid)           from public, anon;
grant execute on function public.is_org_member(uuid, app_role[]) to authenticated;
grant execute on function public.can_read_athlete(uuid)          to authenticated;
grant execute on function public.can_write_athlete(uuid)         to authenticated;
grant execute on function public.shares_org_with(uuid)           to authenticated;

-- ── 开启 RLS ────────────────────────────────────────────────────────────────
alter table public.orgs               enable row level security;
alter table public.app_users          enable row level security;
alter table public.teams              enable row level security;
alter table public.memberships        enable row level security;
alter table public.athletes           enable row level security;
alter table public.athlete_grants     enable row level security;
alter table public.devices            enable row level security;
alter table public.device_credentials enable row level security;
alter table public.activities         enable row level security;
alter table public.raw_samples        enable row level security;
alter table public.metric_registry    enable row level security;
alter table public.daily_metrics      enable row level security;
alter table public.test_sessions      enable row level security;
alter table public.jump_tests         enable row level security;
alter table public.vbt_sets           enable row level security;
alter table public.consents           enable row level security;
alter table public.audit_logs         enable row level security;

-- ── orgs ────────────────────────────────────────────────────────────────────
create policy orgs_select on public.orgs
  for select to authenticated using (public.is_org_member(id));
create policy orgs_update on public.orgs
  for update to authenticated
  using (public.is_org_member(id, array['org_admin']::app_role[]))
  with check (public.is_org_member(id, array['org_admin']::app_role[]));

-- ── app_users ───────────────────────────────────────────────────────────────
create policy app_users_select_self on public.app_users
  for select to authenticated using (id = auth.uid());
create policy app_users_select_colleagues on public.app_users
  for select to authenticated using (public.shares_org_with(id));
create policy app_users_update_self on public.app_users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ── teams ───────────────────────────────────────────────────────────────────
create policy teams_select on public.teams
  for select to authenticated using (public.is_org_member(org_id));
create policy teams_write on public.teams
  for all to authenticated
  using (public.is_org_member(org_id, array['org_admin','team_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['org_admin','team_admin']::app_role[]));

-- ── memberships ─────────────────────────────────────────────────────────────
create policy memberships_select_self on public.memberships
  for select to authenticated using (user_id = auth.uid());
create policy memberships_select_managed on public.memberships
  for select to authenticated
  using (public.is_org_member(org_id, array['org_admin','team_admin']::app_role[]));
create policy memberships_write on public.memberships
  for all to authenticated
  using (public.is_org_member(org_id, array['org_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['org_admin']::app_role[]));

-- ── athletes ────────────────────────────────────────────────────────────────
create policy athletes_select on public.athletes
  for select to authenticated using (public.can_read_athlete(id));
create policy athletes_insert on public.athletes
  for insert to authenticated
  with check (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]));
create policy athletes_update on public.athletes
  for update to authenticated
  using (public.can_write_athlete(id))
  with check (public.can_write_athlete(id));
create policy athletes_delete on public.athletes
  for delete to authenticated
  using (public.is_org_member(org_id, array['org_admin']::app_role[]));

-- ── athlete_grants（可见性给管理者；只读授权，不授予写数据权）──────────────
create policy athlete_grants_select on public.athlete_grants
  for select to authenticated
  using (user_id = auth.uid() or public.can_write_athlete(athlete_id));
create policy athlete_grants_write on public.athlete_grants
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

-- ── devices（个人设备按运动员授权；组织设备池按组织）──────────────────────
create policy devices_select on public.devices
  for select to authenticated
  using (public.is_org_member(org_id) and (athlete_id is null or public.can_read_athlete(athlete_id)));
create policy devices_write on public.devices
  for all to authenticated
  using (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]))
  with check (public.is_org_member(org_id, array['coach','team_admin','org_admin']::app_role[]));

-- device_credentials：故意不建策略 —— 默认拒绝

-- ── activities ──────────────────────────────────────────────────────────────
create policy activities_select on public.activities
  for select to authenticated using (public.can_read_athlete(athlete_id));
create policy activities_write on public.activities
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

-- ── raw_samples ─────────────────────────────────────────────────────────────
create policy raw_samples_select on public.raw_samples
  for select to authenticated using (public.can_read_athlete(athlete_id));
create policy raw_samples_write on public.raw_samples
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

-- ── metric_registry（全局参考数据：登录可读，写仅迁移）────────────────────
create policy metric_registry_select on public.metric_registry
  for select to authenticated using (true);
grant select on public.metric_registry to authenticated;

-- ── daily_metrics ───────────────────────────────────────────────────────────
create policy daily_metrics_select on public.daily_metrics
  for select to authenticated using (public.can_read_athlete(athlete_id));
create policy daily_metrics_write on public.daily_metrics
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

-- ── test_sessions ───────────────────────────────────────────────────────────
create policy test_sessions_select on public.test_sessions
  for select to authenticated using (public.can_read_athlete(athlete_id));
create policy test_sessions_write on public.test_sessions
  for all to authenticated
  using (public.can_write_athlete(athlete_id))
  with check (public.can_write_athlete(athlete_id));

-- ── jump_tests / vbt_sets（经 session 关联到运动员）──────────────────────
create policy jump_tests_select on public.jump_tests
  for select to authenticated
  using (exists (
    select 1 from public.test_sessions s
    where s.id = jump_tests.session_id and public.can_read_athlete(s.athlete_id)
  ));
create policy jump_tests_write on public.jump_tests
  for all to authenticated
  using (exists (
    select 1 from public.test_sessions s
    where s.id = jump_tests.session_id and public.can_write_athlete(s.athlete_id)
  ))
  with check (exists (
    select 1 from public.test_sessions s
    where s.id = jump_tests.session_id and public.can_write_athlete(s.athlete_id)
  ));

create policy vbt_sets_select on public.vbt_sets
  for select to authenticated
  using (exists (
    select 1 from public.test_sessions s
    where s.id = vbt_sets.session_id and public.can_read_athlete(s.athlete_id)
  ));
create policy vbt_sets_write on public.vbt_sets
  for all to authenticated
  using (exists (
    select 1 from public.test_sessions s
    where s.id = vbt_sets.session_id and public.can_write_athlete(s.athlete_id)
  ))
  with check (exists (
    select 1 from public.test_sessions s
    where s.id = vbt_sets.session_id and public.can_write_athlete(s.athlete_id)
  ));

-- ── consents（只能读/写自己的同意记录）────────────────────────────────────
create policy consents_select_self on public.consents
  for select to authenticated using (user_id = auth.uid());
create policy consents_insert_self on public.consents
  for insert to authenticated with check (user_id = auth.uid());
create policy consents_revoke_self on public.consents
  for update to authenticated
  using (user_id = auth.uid() and revoked_at is null)
  with check (user_id = auth.uid());

-- ── audit_logs（只追加）─────────────────────────────────────────────────────
create policy audit_logs_select_self on public.audit_logs
  for select to authenticated using (actor_id = auth.uid());
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (public.is_org_member(org_id, array['org_admin']::app_role[]));
create policy audit_logs_insert_self on public.audit_logs
  for insert to authenticated with check (actor_id = auth.uid());

revoke update, delete on public.audit_logs from authenticated, anon;
