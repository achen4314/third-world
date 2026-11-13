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
