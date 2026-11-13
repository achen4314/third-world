-- ============================================================================
-- 第三世界 · 清库脚本（破坏性，有硬保护，默认拒绝执行）
-- ----------------------------------------------------------------------------
-- 用途：apply-all.sql 是非幂等的，重复执行会报「type already exists」。
--       需要重建时先跑本脚本，再跑 apply-all.sql。
--
-- 硬保护：必须让下面这行 `set app.allow_drop = 'yes-i-am-sure';` 先执行，
--         否则脚本会主动 raise exception 退出，不会删任何东西。
--         要取消保护，把这行删掉即可 —— 那时脚本一律拒绝运行。
--
-- 只删本套 schema 建的对象，不动 Supabase 自带的 auth / storage / extensions。
-- **确认库内无真实数据再跑。** 删表不可逆。
-- ============================================================================

set app.allow_drop = 'yes-i-am-sure';

do $$
begin
  if coalesce(current_setting('app.allow_drop', true), '') <> 'yes-i-am-sure' then
    raise exception '拒绝执行：本脚本会删除 public 下全部业务表。请先执行 set app.allow_drop = ''yes-i-am-sure'';';
  end if;
end $$;

begin;

-- 表（raw_samples 是分区父表，cascade 会一并带走分区子表）
drop table if exists
  public.audit_logs,
  public.consents,
  public.vbt_sets,
  public.jump_tests,
  public.test_sessions,
  public.daily_metrics,
  public.metric_registry,
  public.raw_samples,
  public.activities,
  public.device_credentials,
  public.devices,
  public.athlete_grants,
  public.athletes,
  public.memberships,
  public.teams,
  public.app_users,
  public.orgs
cascade;

-- 鉴权函数
drop function if exists public.is_org_member(uuid, app_role[]) cascade;
drop function if exists public.can_read_athlete(uuid)          cascade;
drop function if exists public.can_write_athlete(uuid)         cascade;
drop function if exists public.shares_org_with(uuid)           cascade;
drop function if exists public.touch_updated_at()              cascade;

-- 枚举
drop type if exists app_role        cascade;
drop type if exists data_source     cascade;
drop type if exists metric_quality  cascade;
drop type if exists metric_tier     cascade;
drop type if exists consent_purpose cascade;
drop type if exists device_kind     cascade;
drop type if exists device_status   cascade;
drop type if exists sex_at_birth    cascade;

commit;

select '已清空 public 下本套对象，可重新执行 apply-all.sql' as "结果";
