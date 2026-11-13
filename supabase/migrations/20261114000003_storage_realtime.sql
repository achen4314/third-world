-- ============================================================================
-- 第三世界 · 0003 存储桶 + 存储策略 + 实时发布
-- ----------------------------------------------------------------------------
-- 前置：0001（建表）+ 0002（RLS）已执行。本文件是**增量**且**幂等**的：
--   重复执行不会报错，也不会清掉已有对象。
--
-- 解决的两件事：
--   1. Storage 桶全空 → 视频 / FIT / 导出包没有隔离目录，任何人拿到 anon key
--      就能读整个 bucket。
--   2. Realtime 发布表全空 → 原型里的 1 Hz 推流只能靠假 SSE，接不上 Supabase。
--
-- 路径约定（桶内第一层/第二层就是权限边界，代码侧必须照此拼路径）：
--   activity-files/{org_id}/{athlete_id}/{activity_id}.fit|.gpx|.tcx
--   session-videos/{org_id}/{athlete_id}/{session_id}.mp4
--   exports/{org_id}/{user_id}/{request_id}.json          ← 个人信息导出包
--   avatars/{user_id}/avatar.jpg                          ← 不含 org，跨组织也不串
--
-- 权限模型（与 0002 的 RBAC 完全一致，不另立一套）：
--   · 只读：can_read_athlete(第二层 athlete_id)      —— 队员本人 / 单人授权 / 同组织同队
--   · 写入：can_write_athlete(第二层 athlete_id)     —— coach / team_admin / org_admin / clinician
--   · 导出包：只能本人读写自己那一层（第一层 org + 第二层 = auth.uid()）
--   · 头像：本人可写；同组织同事可读（shares_org_with），不对外公开
--
-- 为什么不公开桶：公开桶 = 绕过 RLS 的永久免签 URL，运动员视频属敏感个人信息
-- （docs/06 D6），一旦公开即不可撤回。取图一律用 createSignedUrl（默认 60s）。
--
-- 安全取舍：
--   · 策略全部 `to authenticated`，不写 anon 分支 → anon 上传/下载一律拒绝。
--   · 路径里的 uuid 用 arc_uuid_or_null() 安全转换：非法路径返回 null → 策略判定
--     false（拒绝），而不是抛 22P02 让客户端拿到 500。
--   · raw_samples（高频分区表）**不进** Realtime 发布：100 Hz × 多通道会把 WAL 和
--     免费档 500 MB 一起打爆。实时曲线走「客户端缓冲 + 后端聚合推送」，见 docs/04。
-- ============================================================================

begin;

-- ── 0. 安全类型转换：非法 uuid 返回 null，不抛异常 ───────────────────────────
create or replace function public.arc_uuid_or_null(t text)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if t is null or t = '' then
    return null;
  end if;
  return t::uuid;
exception
  when others then
    return null;
end;
$$;
comment on function public.arc_uuid_or_null(text) is
  '存储策略用：把桶内路径段安全转 uuid。非法值返回 null，让策略判定 false，避免抛 22P02。';

revoke all on function public.arc_uuid_or_null(text) from public, anon;
grant execute on function public.arc_uuid_or_null(text) to authenticated;

-- ============================================================================
-- 1. 存储桶（4 个，全部私有）
-- ============================================================================
-- file_size_limit 说明：免费档单文件上限 50 MiB，桶上限再高也会被项目上限截断；
-- 视频暂定 50 MiB（≈ 3 分钟 720p）。付费档或改直传 R2/OSS 后再调大。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('activity-files', 'activity-files', false, 52428800,
   array['application/octet-stream','application/zip','application/gpx+xml',
         'application/vnd.garmin.fit','application/x-fit','text/xml','text/csv']),
  ('session-videos', 'session-videos', false, 52428800,
   array['video/mp4','video/quicktime','video/x-m4v']),
  ('exports',        'exports',        false, 52428800,
   array['application/json','application/zip']),
  ('avatars',        'avatars',        false, 5242880,
   array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================================
-- 2. 存储策略（16 条：4 桶 × 读/增/改/删）
-- ============================================================================
-- 幂等：先 drop 再建，避免重复执行时 42710 (duplicate_object)。

-- ── 2.1 activity-files：训练原始文件（FIT / GPX / TCX / 打包 CSV）────────────
drop policy if exists arc_activity_files_read   on storage.objects;
drop policy if exists arc_activity_files_insert on storage.objects;
drop policy if exists arc_activity_files_update on storage.objects;
drop policy if exists arc_activity_files_delete on storage.objects;

create policy arc_activity_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'activity-files'
    and public.can_read_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_activity_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'activity-files'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_activity_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'activity-files'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  )
  with check (
    bucket_id = 'activity-files'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_activity_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'activity-files'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

-- ── 2.2 session-videos：纵跳 / 冲刺 / VBT 拍摄视频（My Jump Lab 同源素材）────
drop policy if exists arc_session_videos_read   on storage.objects;
drop policy if exists arc_session_videos_insert on storage.objects;
drop policy if exists arc_session_videos_update on storage.objects;
drop policy if exists arc_session_videos_delete on storage.objects;

create policy arc_session_videos_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'session-videos'
    and public.can_read_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_session_videos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'session-videos'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_session_videos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'session-videos'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  )
  with check (
    bucket_id = 'session-videos'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

create policy arc_session_videos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'session-videos'
    and public.can_write_athlete(public.arc_uuid_or_null((storage.foldername(name))[2]))
  );

-- ── 2.3 exports：个人信息导出包（PIPL 可携带权）。只有本人能碰自己那一层 ──────
-- 路径：exports/{org_id}/{user_id}/{request_id}.json
drop policy if exists arc_exports_read   on storage.objects;
drop policy if exists arc_exports_insert on storage.objects;
drop policy if exists arc_exports_update on storage.objects;
drop policy if exists arc_exports_delete on storage.objects;

create policy arc_exports_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy arc_exports_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'exports'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_org_member(public.arc_uuid_or_null((storage.foldername(name))[1]))
  );

create policy arc_exports_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'exports'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy arc_exports_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ── 2.4 avatars：头图。本人可写，同组织同事可读 ───────────────────────────────
-- 路径：avatars/{user_id}/avatar.jpg
drop policy if exists arc_avatars_read   on storage.objects;
drop policy if exists arc_avatars_insert on storage.objects;
drop policy if exists arc_avatars_update on storage.objects;
drop policy if exists arc_avatars_delete on storage.objects;

create policy arc_avatars_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.shares_org_with(public.arc_uuid_or_null((storage.foldername(name))[1]))
    )
  );

create policy arc_avatars_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy arc_avatars_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy arc_avatars_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- 3. 实时发布（Realtime / postgres_changes）
-- ============================================================================
-- 发布 8 张「读得勤、写得少」的表。RLS 由 Realtime 服务端按订阅者身份重放，
-- 因此 0002 的 select 策略直接决定谁能收到哪些行，这里不再重复鉴权。

do $$
declare
  t text;
  published text[] := array[
    'activities',     -- 训练总结页：新完成一条即刷新
    'daily_metrics',  -- 仪表盘：TL / ACWR / HRV / 睡眠分逐日刷新
    'test_sessions',  -- 测试列表
    'jump_tests',     -- 纵跳结果（My Jump Lab 口径）
    'vbt_sets',       -- VBT 组内速度
    'devices',        -- 设备在线状态与 last_sync_at
    'athletes',       -- 队员档案与在训状态
    'memberships'     -- 权限变更需即时踢出/放行
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array published loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- ── 3.1 REPLICA IDENTITY ────────────────────────────────────────────────────
-- 默认（default）只把主键放进 DELETE 旧记录；订阅端收到 DELETE 只能知道「哪一行没了」。
-- 下面 7 张表行数少、删除需要还原上下文，设 full；daily_metrics 行数会很快上万，
-- 保持 default 以免 WAL 膨胀（它的删除在应用里是「重算覆盖」，不需要旧值）。
alter table public.activities    replica identity full;
alter table public.test_sessions replica identity full;
alter table public.jump_tests    replica identity full;
alter table public.vbt_sets      replica identity full;
alter table public.devices       replica identity full;
alter table public.athletes      replica identity full;
alter table public.memberships   replica identity full;
alter table public.daily_metrics replica identity default;

-- ── 3.2 显式排除高频表（写进注释，防后来人「顺手加进去」）───────────────────
-- raw_samples 按 ts 分区，100 Hz × N 通道 ≈ 每天数百万行；进发布后 Realtime
-- 侧解码与 WAL 保留都会拖垮免费档（500 MB）。实时波形请走后端聚合 + WebSocket。
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'raw_samples'
  ) then
    alter publication supabase_realtime drop table public.raw_samples;
  end if;
end;
$$;

-- ============================================================================
-- 4. 自检（执行完看这张表：状态列全 ✓ 即成功）
-- ============================================================================
with checks(item, actual, expect) as (
  select '存储桶数量', (select count(*) from storage.buckets where id in
          ('activity-files','session-videos','exports','avatars'))::text, '4'
  union all
  select '公开桶数量（应 0）', (select count(*) from storage.buckets where public)::text, '0'
  union all
  select 'storage.objects 策略数',
         (select count(*) from pg_policies where schemaname='storage' and tablename='objects')::text, '16'
  union all
  select '策略未限定 authenticated（应 0）',
         (select count(*) from pg_policies
           where schemaname='storage' and tablename='objects'
             and not ('authenticated' = any(roles)))::text, '0'
  union all
  select '路径安全转换函数',
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='arc_uuid_or_null')::text, '1'
  union all
  select '实时发布表数',
         (select count(*) from pg_publication_tables where pubname='supabase_realtime')::text, '8'
  union all
  select 'raw_samples 已排除（应 0）',
         (select count(*) from pg_publication_tables
           where pubname='supabase_realtime' and tablename='raw_samples')::text, '0'
  union all
  select 'replica identity=full 表数',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='r' and c.relreplident='f')::text, '7'
  union all
  select 'daily_metrics 仍为 default(d)',
         (select c.relreplident::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname='daily_metrics'), 'd'
  union all
  select 'authenticated 可读 daily_metrics（Realtime 前提）',
         has_table_privilege('authenticated','public.daily_metrics','SELECT')::text, 'true'
  union all
  select 'anon 仍不可读 storage.objects 策略命中（应 0）',
         (select count(*) from pg_policies
           where schemaname='storage' and tablename='objects'
             and 'anon' = any(roles))::text, '0'
)
select item as "检查项", actual as "实际", expect as "期望",
       case when actual = expect then '✓' else '≠ 需排查' end as "状态"
from checks;

commit;
