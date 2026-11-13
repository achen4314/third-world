-- ============================================================================
-- 第三世界 · 0004 权限加固与结构补漏
-- ----------------------------------------------------------------------------
-- 由 tools/audit-db.mjs 对真实托管库的核查结果驱动，逐条对应「实际 ≠ 期望」的项。
-- 幂等，可重复执行。
--
-- 修的四类问题（都是核查实测出来的，不是推测）：
--   1. 【真漏洞】Supabase 的默认权限（pg_default_acl: arwdDxtm）让 anon 在全部
--      业务表上持有 INSERT/UPDATE/DELETE/**TRUNCATE**。
--      RLS 只拦 DML 的行级访问，**TRUNCATE 完全不受 RLS 约束** —— 只要有任意一条
--      能把 SQL 以 anon 身份执行的路径（注入、被误授的 RPC、错配的 service key），
--      就能清空整表。必须 revoke。同理 REFERENCES / TRIGGER 这两个 DDL 级权限也收回。
--   2. 9 个外键列没有索引：删除父行时逐一全表扫，是 O(N) 写放大来源。
--   3. device_credentials / daily_metrics 有 updated_at 却无更新触发器，
--      时间戳靠调用方自觉写 —— 与其余 5 张表不一致，改为统一由触发器维护。
--   4. audit_logs.org_id 故意不建外键（组织注销后审计仍需留存），但没写注释，
--      后人容易当成漏建而"修"坏。补注释固化这个决定。
--
-- 另外把「未来新建表」的默认权限一起收掉（alter default privileges），
-- 否则明天加一张表，anon 的 TRUNCATE 又回来了。
-- ============================================================================

begin;

-- ── 1. 收回 anon 的全部业务表权限 ───────────────────────────────────────────
-- 原型阶段没有任何匿名访问需求：登录才看得见数据。将来若要做「公开分享页」，
-- 再按表单独 grant select 给 anon，而不是反过来大面积收。
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 未来新建的表/序列也一并收回（改的是 postgres 的默认权限条目）
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- ── 2. authenticated 只保留 DML，收回 DDL 级与整表级权限 ────────────────────
-- TRUNCATE：整表清空，不受 RLS 约束，应用侧永远用不到
-- REFERENCES：无外键需求，留着只是扩大攻击面
-- TRIGGER：能往表上挂触发器（等于能改数据流），RLS 管不到
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- ── 3. 平台自建函数：收回 anon 的执行权 ─────────────────────────────────────
-- rls_auto_enable 是 Supabase 平台的 RLS 自动开启事件函数（属主 postgres，
-- 不是本仓库创建的）。它返回 event_trigger，本就不能被直接调用，但既然 anon
-- 持有 EXECUTE 就多一条不必要的暴露面，一并收回；事件触发器以属主身份运行，
-- 不受影响。
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

-- ── 4. 补齐外键索引（核查列出的 9 处）──────────────────────────────────────
create index if not exists idx_activities_org           on public.activities (org_id);
create index if not exists idx_test_sessions_org        on public.test_sessions (org_id);
create index if not exists idx_test_sessions_created_by on public.test_sessions (created_by);
create index if not exists idx_daily_metrics_metric     on public.daily_metrics (metric_id);
create index if not exists idx_athletes_team            on public.athletes (team_id);
create index if not exists idx_athlete_grants_user      on public.athlete_grants (user_id);
create index if not exists idx_athlete_grants_granted_by on public.athlete_grants (granted_by);
create index if not exists idx_memberships_team         on public.memberships (team_id);
create index if not exists idx_memberships_granted_by   on public.memberships (granted_by);

-- ── 5. 时间戳触发器补统一 ──────────────────────────────────────────────────
drop trigger if exists trg_device_credentials_touch on public.device_credentials;
create trigger trg_device_credentials_touch before update on public.device_credentials
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_daily_metrics_touch on public.daily_metrics;
create trigger trg_daily_metrics_touch before update on public.daily_metrics
  for each row execute function public.touch_updated_at();

-- ── 6. 固化「audit_logs.org_id 无外键」这个决定 ─────────────────────────────
comment on column public.audit_logs.org_id is
  '故意不建外键：组织注销/迁移后审计记录仍须留存，故保留历史 org_id 裸值。'
  '这不是漏建 —— tools/audit-db.mjs 已把它列入白名单，改前请先读本注释。';

-- ── 7. 自检 ────────────────────────────────────────────────────────────────
with checks(item, actual, expect) as (
  select 'anon 持有的表级权限数（应 0）',
         (select count(*) from information_schema.role_table_grants
           where table_schema='public' and grantee='anon')::text, '0'
  union all
  select 'anon 可 TRUNCATE 的表数（应 0）',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p')
             and has_table_privilege('anon', c.oid, 'TRUNCATE'))::text, '0'
  union all
  select 'authenticated 可 TRUNCATE 的表数（应 0）',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p')
             and has_table_privilege('authenticated', c.oid, 'TRUNCATE'))::text, '0'
  union all
  select 'authenticated 仍可 SELECT（须 > 0）',
         (case when (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p')
             and has_table_privilege('authenticated', c.oid, 'SELECT')) > 0 then 'yes' else 'no' end), 'yes'
  union all
  select 'postgres 默认权限里 anon 的表条目（应 0）',
         (select count(*) from pg_default_acl a
           join pg_namespace n on n.oid=a.defaclnamespace
           cross join lateral aclexplode(a.defaclacl) x
           join pg_roles r on r.oid = x.grantee
           where n.nspname='public' and a.defaclobjtype='r'
             and r.rolname='anon' and pg_get_userbyid(a.defaclrole)='postgres')::text, '0'
  union all
  -- supabase_admin 的默认权限改不动（postgres 不是其成员，实测 42501）。
  -- 只要建表始终由 postgres 执行（本项目所有迁移都如此），它就不会生效；
  -- 若将来在 Dashboard 表编辑器里建表，需手工 revoke —— 此处只做可见化，不判失败。
  select 'supabase_admin 默认权限仍含 anon（平台侧，不可改）',
         (select count(*) from pg_default_acl a
           join pg_namespace n on n.oid=a.defaclnamespace
           cross join lateral aclexplode(a.defaclacl) x
           join pg_roles r on r.oid = x.grantee
           where n.nspname='public' and a.defaclobjtype='r'
             and r.rolname='anon' and pg_get_userbyid(a.defaclrole)='supabase_admin')::text, '8'
  union all
  select '外键列缺索引数（应 0）',
         (select count(*) from (
            select con.conrelid as rel, con.conkey[1] as attnum
            from pg_constraint con
            join pg_class c on c.oid=con.conrelid
            join pg_namespace n on n.oid=c.relnamespace
            where con.contype='f' and n.nspname='public' and array_length(con.conkey,1)=1
          ) fk
          where not exists (select 1 from pg_index i where i.indrelid=fk.rel and i.indkey[0]=fk.attnum))::text, '0'
  union all
  select '有 updated_at 却无触发器的表（应 0）',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind in ('r','p')
             and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='updated_at' and not a.attisdropped)
             and not exists (select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal))::text, '0'
  union all
  select 'anon 可执行的 SECURITY DEFINER 函数（应 0）',
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.prosecdef
             and has_function_privilege('anon', p.oid, 'EXECUTE'))::text, '0'
  union all
  select 'authenticated 可执行的鉴权函数（应 5）',
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public'
             and p.proname in ('is_org_member','can_read_athlete','can_write_athlete','shares_org_with','arc_uuid_or_null')
             and has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text, '5'
)
select item as "检查项", actual as "实际", expect as "期望",
       case when actual = expect then '✓' else '≠ 需排查' end as "状态"
from checks;

commit;
