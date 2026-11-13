-- ============================================================================
-- 第三世界 · 一次性建库脚本（SQL Editor 可直接整段粘贴执行）
-- ----------------------------------------------------------------------------
-- 内容 = migrations/0001_init.sql + migrations/0002_rls.sql + seed.sql + 末尾自检
-- 目标库：Supabase 托管 Postgres 15+（全新空库）
--
-- 用法：
--   Supabase Dashboard → SQL Editor → 新建查询 → 粘贴本文件全部内容 → Run
--   执行完看最后一张「自检」表：状态列全为 ✓ 即建库成功。
--
-- 安全与边界：
--   · 整段包在单事务里：任一句报错 → 全部回滚，不会留下半成品库。
--   · 非幂等：重复执行会因「类型已存在」报错。重复执行前先跑 supabase/reset.sql
--     （该脚本会删表，属破坏性操作，仅在确认库内无真实数据时使用）。
--   · 本脚本不含任何运动员数据，seed 只写 metric_registry 的 30 条口径参考行。
--   · 所有表启用 RLS；device_credentials 不建任何策略 = 默认拒绝，仅 service_role 可达。
--
-- 若在 SQL Editor 报错，把报错原文（含 SQLSTATE）给我，我按报错改，不猜。
-- ============================================================================

begin;

-- ============================================================================
-- 第三世界 · 0001 初始化 schema
-- 目标环境：Supabase 托管 Postgres 15+
-- 口径来源：docs/01（信息架构）、docs/03 §4（数据模型）、docs/06 §8（决策默认值）
--
-- 本文采用的假设（未经你最终确认，改一处即可，不必重构）：
--   · 多租户：所有租户表带 org_id（docs/06 D7 推荐「多组织」，起初只有一个机构也留位）
--   · 身份：Supabase Auth，app_users.id 外键指向 auth.users(id)（D4 若改自建 Auth，只需改此表来源）
--   · 健康数据：HRV / 睡眠 / 伤病 / 月经周期均落库，一律按敏感个人信息处理（D6）
--   · 时区：默认 Asia/Shanghai，组织可覆盖（docs/06 B6）
--
-- 安全取舍：所有业务表 ENABLE ROW LEVEL SECURITY（策略见 0002），但**不使用 FORCE**。
--   原因：Supabase 的 postgres 是表属主，FORCE 会让 Studio 与迁移自身也被策略拦住；
--   应用侧只用 anon / authenticated，service_role 具备 BYPASSRLS，风险面不受影响。
--   若后续自建 Postgres 且应用与属主同角色，再补 FORCE。
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 枚举 ────────────────────────────────────────────────────────────────────
create type app_role        as enum ('athlete','coach','team_admin','org_admin','analyst','clinician','observer');
create type data_source     as enum ('device','import','manual','api');
create type metric_quality  as enum ('ok','partial','missing','estimated');
create type metric_tier     as enum ('core','vendor_aligned');
create type consent_purpose as enum ('terms','privacy','health_data','research','marketing','guardian');
create type device_kind     as enum ('hr_strap','watch','bike_trainer','treadmill','vbt_imu','phone');
create type device_status   as enum ('pending','active','expired','revoked');
create type sex_at_birth    as enum ('female','male','unspecified');

-- ── 通用触发器 ──────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── 组织 / 用户 / 队伍 ──────────────────────────────────────────────────────
create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  timezone   text not null default 'Asia/Shanghai',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_orgs_touch before update on public.orgs
  for each row execute function public.touch_updated_at();

comment on table public.orgs is '租户根表。所有业务数据经 org_id 隔离，RLS 第一层过滤维度。';

create table public.app_users (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text,
  locale              text not null default 'zh-CN',
  is_minor            boolean not null default false,
  guardian_consent_at timestamptz,
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_app_users_touch before update on public.app_users
  for each row execute function public.touch_updated_at();

comment on column public.app_users.is_minor is '不满 14 周岁须监护人同意（PIPL），guardian_consent_at 非空方可入库健康数据。';

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  sport      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index idx_teams_org on public.teams (org_id);
create trigger trg_teams_touch before update on public.teams
  for each row execute function public.touch_updated_at();

-- 授权表：一行 = 一条授权。team_id 为空表示组织级授权。
create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete cascade,
  role       app_role not null,
  granted_by uuid references public.app_users(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz
);
create unique index memberships_unique
  on public.memberships (user_id, org_id, role, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index idx_memberships_org_role on public.memberships (org_id, role);
comment on table public.memberships is 'RBAC 唯一事实源：角色 + 范围（org 级 / team 级）+ 有效期。前端 PERMISSIONS 仅作展示，不参与鉴权。';

-- ── 运动员 ──────────────────────────────────────────────────────────────────
create table public.athletes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete set null,
  user_id    uuid references public.app_users(id) on delete set null,
  full_name  text not null check (length(btrim(full_name)) between 1 and 120),
  sex        sex_at_birth not null default 'unspecified',
  birth_date date check (birth_date is null or birth_date > date '1900-01-01'),
  height_cm  numeric(5,1) check (height_cm is null or height_cm between 80 and 250),
  weight_kg  numeric(5,1) check (weight_kg is null or weight_kg between 20 and 300),
  status     text not null default 'active' check (status in ('active','injured','retired','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_athletes_org_team on public.athletes (org_id, team_id);
create unique index athletes_user_unique on public.athletes (user_id) where user_id is not null;
create trigger trg_athletes_touch before update on public.athletes
  for each row execute function public.touch_updated_at();

-- 单人授权：跨队/临时协作（如队医只看某一人）
create table public.athlete_grants (
  athlete_id uuid not null references public.athletes(id) on delete cascade,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  reason     text,
  granted_by uuid references public.app_users(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (athlete_id, user_id)
);

-- ── 设备与凭据 ──────────────────────────────────────────────────────────────
create table public.devices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  athlete_id   uuid references public.athletes(id) on delete cascade,
  kind         device_kind not null,
  vendor       text,
  model        text,
  serial       text,
  status       device_status not null default 'pending',
  last_sync_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, serial)
);
create index idx_devices_athlete on public.devices (athlete_id);
create trigger trg_devices_touch before update on public.devices
  for each row execute function public.touch_updated_at();

-- 仅 service_role 可访问：0002 故意不为本表建任何策略，RLS 开启后 anon/authenticated 全部拒绝。
create table public.device_credentials (
  device_id             uuid primary key references public.devices(id) on delete cascade,
  provider              text not null,
  access_token_cipher    bytea not null,
  refresh_token_cipher   bytea,
  key_version            smallint not null default 1,
  scopes                 text[],
  expires_at             timestamptz,
  updated_at             timestamptz not null default now()
);
comment on table public.device_credentials is '厂商 OAuth 令牌密文（AES-GCM，密钥来自服务端环境变量）。无 RLS 策略 = 默认拒绝，只有 service_role 可读写。';

-- ── 训练与采样 ──────────────────────────────────────────────────────────────
create table public.activities (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  athlete_id    uuid not null references public.athletes(id) on delete cascade,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  sport         text not null,
  duration_s    integer check (duration_s is null or duration_s >= 0),
  distance_m    numeric(10,1) check (distance_m is null or distance_m >= 0),
  training_load numeric(8,2) check (training_load is null or training_load >= 0),
  load_method   text check (load_method in ('tss','srpe','hr','power')),
  rpe           smallint check (rpe is null or rpe between 0 and 10),
  source        data_source not null default 'manual',
  external_id   text,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at),
  unique (athlete_id, source, external_id)
);
create index idx_activities_athlete_time on public.activities (athlete_id, started_at desc);

-- 高频采样：按月分区。Supabase 托管实例不提供 TimescaleDB，故走原生分区。
create table public.raw_samples (
  id         bigserial,
  athlete_id uuid not null references public.athletes(id) on delete cascade,
  session_id uuid,
  channel    text not null,
  ts         timestamptz not null,
  value      double precision not null,
  source     data_source not null default 'device',
  primary key (id, ts)
) partition by range (ts);

create table public.raw_samples_default partition of public.raw_samples default;
create index idx_raw_samples_athlete_ts on public.raw_samples (athlete_id, ts desc);
comment on table public.raw_samples is '原始高频采样（1 Hz ~ 100 Hz）。免费档 500MB 极易打满：生产建议原始数据落对象存储，库内只留聚合（docs/06 B7）。';

-- ── 指标口径注册表 ──────────────────────────────────────────────────────────
create table public.metric_registry (
  metric_id    text primary key,
  label        text not null,
  unit         text,
  category     text not null,
  formula      text,
  calc_version text not null default 'v1.0',
  tier         metric_tier not null default 'core',
  is_sensitive boolean not null default false,
  notes        text
);
comment on table public.metric_registry is '公式唯一定义源。tier=core 参与 ARC 可解释决策；tier=vendor_aligned 仅作对标展示，禁止进入训练建议生成（docs/04 §3）。';

create table public.daily_metrics (
  org_id       uuid not null references public.orgs(id) on delete cascade,
  athlete_id   uuid not null references public.athletes(id) on delete cascade,
  metric_date  date not null,
  metric_id    text not null references public.metric_registry(metric_id),
  value        numeric(12,4),
  unit         text,
  quality      metric_quality not null default 'ok',
  source       data_source not null default 'device',
  calc_version text not null default 'v1.0',
  updated_at   timestamptz not null default now(),
  primary key (athlete_id, metric_date, metric_id)
);
create index idx_daily_metrics_org_date on public.daily_metrics (org_id, metric_date desc);
comment on column public.daily_metrics.value is '缺测一律写 NULL + quality=missing，**不补 0、不插值**（沿用原型「不估算、不补造」原则）。';

-- ── 测试会话 ────────────────────────────────────────────────────────────────
create table public.test_sessions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  athlete_id   uuid not null references public.athletes(id) on delete cascade,
  kind         text not null check (kind in ('jump','sprint','cod','mobility','nordic','vbt','wellness','other')),
  performed_at timestamptz not null,
  protocol     jsonb,
  notes        text,
  source       data_source not null default 'device',
  created_by   uuid references public.app_users(id),
  created_at   timestamptz not null default now()
);
create index idx_test_sessions_athlete on public.test_sessions (athlete_id, performed_at desc);

create table public.jump_tests (
  session_id  uuid primary key references public.test_sessions(id) on delete cascade,
  jump_type   text not null check (jump_type in ('cmj','sj','dj','rj','slj')),
  height_cm   numeric(6,2) check (height_cm is null or height_cm > 0),
  contact_ms  numeric(7,2) check (contact_ms is null or contact_ms >= 0),
  flight_ms   numeric(7,2) check (flight_ms is null or flight_ms >= 0),
  rsi         numeric(6,3) check (rsi is null or rsi >= 0),
  video_fps   numeric(6,2),
  quality     metric_quality not null default 'ok'
);
comment on column public.jump_tests.height_cm is '飞行时间法 h = g·t_f²/8。video_fps 为空时视频法不可计算，不猜帧率。';

create table public.vbt_sets (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.test_sessions(id) on delete cascade,
  exercise   text not null,
  load_kg    numeric(6,2) check (load_kg is null or load_kg >= 0),
  reps       smallint check (reps is null or reps > 0),
  mcv        numeric(6,3),
  mpv        numeric(6,3),
  pv         numeric(6,3),
  vl_pct     numeric(5,2),
  power_w    numeric(8,2),
  quality    metric_quality not null default 'ok'
);
create index idx_vbt_sets_session on public.vbt_sets (session_id);

-- ── 同意与审计 ──────────────────────────────────────────────────────────────
create table public.consents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.app_users(id) on delete cascade,
  purpose        consent_purpose not null,
  policy_version text not null,
  granted_at     timestamptz,
  revoked_at     timestamptz,
  evidence       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  check (granted_at is not null or revoked_at is not null)
);
create unique index consents_active_unique
  on public.consents (user_id, purpose, policy_version) where revoked_at is null;
comment on table public.consents is '版本化同意记录。敏感个人信息（health_data）须单独同意，撤回即触发下游停处理。';

create table public.audit_logs (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid references public.app_users(id) on delete set null,
  org_id      uuid,
  action      text not null,
  target_type text,
  target_id   text,
  request_id  text,
  ip          inet,
  detail      jsonb
);
create index idx_audit_org_time on public.audit_logs (org_id, occurred_at desc);
create index idx_audit_actor_time on public.audit_logs (actor_id, occurred_at desc);
comment on table public.audit_logs is '只追加。记录「谁看了谁的哪些数据」的动作与对象，detail 不写数值内容，避免日志泄露健康数据。';

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

-- ============================================================================
-- 第三世界 · 指标口径种子
-- 仅为 metric_registry 参考数据，不含任何运动员数据（不造真实数据）。
-- core        = ARC 自有可解释口径，参与训练建议生成
-- vendor_aligned = 对标展示占位（名称/刻度/分档来自公开资料），**不参与决策**，
--                  且在 UI 必须带 DEMO 标记（docs/04 §3、§5）
-- ============================================================================

insert into public.metric_registry (metric_id, label, unit, category, formula, calc_version, tier, is_sensitive, notes) values
  -- 负荷与周期
  ('ctl',            '慢性负荷 CTL',    'AU',  'load', 'CTL_t = CTL_{t-1} + (TL_t - CTL_{t-1}) / 42', 'v1.0', 'core', false, '42 日指数加权'),
  ('atl',            '急性负荷 ATL',    'AU',  'load', 'ATL_t = ATL_{t-1} + (TL_t - ATL_{t-1}) / 7',  'v1.0', 'core', false, '7 日指数加权'),
  ('tsb',            '负荷平衡 TSB',    'AU',  'load', 'TSB_t = CTL_{t-1} - ATL_{t-1}',                'v1.0', 'core', false, '训练前状态，非当日差值'),
  ('acwr.rolling',   'ACWR（滚动）',    'ratio','load','ACWR = TL_7d / (TL_28d / 4)',                  'v1.0', 'core', false, '急性窗含于慢性窗，存在数学耦合'),
  ('acwr.ewma',      'ACWR（EWMA）',    'ratio','load','ACWR = EWMA_7(TL) / EWMA_28(TL)',               'v1.0', 'core', false, '主口径'),
  ('tl.tss',         '训练负荷 TSS',    'AU',  'load', 'TSS = (sec × NP × IF) / (FTP × 3600) × 100',   'v1.0', 'core', false, '需功率或配速阈值'),
  ('tl.srpe',        '训练负荷 sRPE',   'AU',  'load', 'sRPE = RPE × duration_min',                    'v1.0', 'core', false, 'RPE 缺失时不可计算'),
  ('tm',             '训练单调性 TM',   'ratio','load','TM = mean(TL_7d) / sd(TL_7d)',                 'v1.0', 'core', false, '周内标准差为 0 时不可计算'),
  ('ts',             '训练应变 TS',     'AU',  'load', 'TS = TL_7d_total × TM',                        'v1.0', 'core', false, '依赖 TM，TM 不可算则 TS 不可算'),
  -- 恢复与睡眠
  ('hrv.rmssd',      'HRV · RMSSD',     'ms',  'recovery', 'RMSSD = sqrt(mean(ΔRR²))',                 'v1.0', 'core', true,  '敏感：健康数据'),
  ('hrv.lnrmssd',    'HRV · lnRMSSD',   'ln(ms)','recovery','lnRMSSD = ln(RMSSD)',                     'v1.0', 'core', true,  '敏感：健康数据'),
  ('sleep.tst',      '总睡眠时长 TST',  'min', 'recovery', 'TST = Σ 睡眠期时长',                       'v1.0', 'core', true,  '敏感：健康数据'),
  ('sleep.efficiency','睡眠效率',       '%',   'recovery', 'SE = TST / TIB × 100',                     'v1.0', 'core', true,  'TIB = 卧床总时长'),
  -- 跳跃
  ('jump.height',    '跳跃高度（飞行时间法）','cm','jump','h = g · t_f² / 8',                         'v1.0', 'core', false, 't_f 为飞行时间；视频法需 fps，缺则不可计算'),
  ('jump.contact_time','触地时间',      'ms',  'jump', '-',                                                 'v1.0', 'core', false, '需测力台或高速摄像'),
  ('jump.rsi',       '反应力量指数 RSI','m/s', 'jump', 'RSI = h / t_c',                                   'v1.0', 'core', false, 't_c 为触地时间（秒）'),
  ('jump.ppo',       '峰值功率 PPO',    'W',   'jump', 'PPO = 60.7 × h + 45.3 × BM − 2055',               'v1.0', 'core', false, 'Sayers 方程，需体重'),
  -- VBT
  ('vbt.mcv',        '平均向心速度 MCV', 'm/s', 'vbt', 'MCV = Δ位移 / 向心时长',                        'v1.0', 'core', false, 'IMU 积分 + ZUPT 修正'),
  ('vbt.vl',         '速度损失 VL',      '%',   'vbt', 'VL = (MCV_best − MCV_last) / MCV_best × 100',   'v1.0', 'core', false, '组内首末次比较'),
  ('vbt.lvp',        '负荷-速度剖面 R²', '-',   'vbt', '线性回归 load ~ MCV 的 R²',                     'v1.0', 'core', false, '标定点不足时不可计算'),
  ('vbt.1rm',        '估算 1RM',         'kg',  'vbt', '由 LVP 回归外推至最小速度阈值',                  'v1.0', 'core', false, '未标定时返回不可计算，不猜测'),
  ('vbt.power',      '输出功率',         'W',   'vbt', 'P = F · v（含质量与加速度修正）',                'v1.0', 'core', false, 'IMU 加速度积分'),
  -- 对标展示占位（不参与决策）
  ('evlab.status',   'EvoLab 训练状态',  '-',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值，非厂商算法'),
  ('evlab.recovery', 'EvoLab 恢复计时',  'h',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值'),
  ('evlab.running',  'EvoLab 跑步表现',  '-',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值'),
  ('te.aerobic',     'Training Effect 有氧', '-','vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('te.anaerobic',   'Training Effect 无氧', '-','vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('sleep.score',    '睡眠评分',         '-',   'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('hrv.status',     'HRV 状态',         '-',   'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('coros.hrv',      '夜间 HRV 均值',    'ms',  'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值')
on conflict (metric_id) do nothing;

-- ============================================================================
-- 自检：执行完会在结果区显示这张表，状态列全 ✓ 即通过
-- ============================================================================
with checks as (
  select '业务表数量（含 1 张分区默认子表）'::text as item,
         (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','p'))::text as actual,
         '18'::text as expect
  union all
  select '已启用 RLS 的表（分区子表继承父表策略，故为 17）',
         (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity)::text,
         '17'
  union all
  select 'RLS 策略数量',
         (select count(*) from pg_policies where schemaname = 'public')::text,
         '37'
  union all
  select '鉴权与触发器函数（5 个）',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('is_org_member','can_read_athlete','can_write_athlete','shares_org_with','touch_updated_at'))::text,
         '5'
  union all
  select '指标口径总数',
         (select count(*) from public.metric_registry)::text,
         '30'
  union all
  select '其中 core（参与决策）',
         (select count(*) from public.metric_registry where tier = 'core')::text,
         '22'
  union all
  select '其中 vendor_aligned（仅对标展示，隔离）',
         (select count(*) from public.metric_registry where tier = 'vendor_aligned')::text,
         '8'
  union all
  select 'device_credentials 策略数（应为 0 = 默认拒绝）',
         (select count(*) from pg_policies where schemaname = 'public' and tablename = 'device_credentials')::text,
         '0'
  union all
  select 'audit_logs 是否禁止 UPDATE（应 false）',
         has_table_privilege('authenticated','public.audit_logs','UPDATE')::text,
         'false'
  union all
  select 'audit_logs 是否禁止 DELETE（应 false）',
         has_table_privilege('authenticated','public.audit_logs','DELETE')::text,
         'false'
  union all
  select 'daily_metrics.value 是否可空（缺测不补 0）',
         (select is_nullable from information_schema.columns
           where table_schema='public' and table_name='daily_metrics' and column_name='value')::text,
         'YES'
)
select item as "检查项", actual as "实际", expect as "期望",
       case when actual = expect then '✓' else '≠ 需排查' end as "状态"
from checks;

commit;
