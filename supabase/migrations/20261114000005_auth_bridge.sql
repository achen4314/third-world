-- 第三世界 · 0005 注册桥接
--
-- 问题（核查 tools/audit-db.mjs 时发现）：
--   auth.users 有 `on_auth_user_created` 之类的桥接触发器？没有。项目里一条都没有。
--   而 public.app_users 有主键 id 且全表 RLS，还有一堆外键指向它（athletes.user_id、
--   memberships.user_id、audit_logs.actor_id）。
--   结果：用户用邮箱注册成功 → auth.users 有行 → public.app_users 没有行 →
--   任何 "select ... from app_users where id = auth.uid()" 都返回空 →
--   首屏拿不到 display_name，写 audit_logs 时因外键失败。
--   也就是说「注册完第一次进 App」一定会崩，只是现在还没人注册过，所以没暴露。
--
-- 做法：
--   1) 建 security definer 触发器函数，注册时补一行 app_users（幂等 on conflict）。
--   2) 回填历史上已注册但没有 app_users 行的用户（当前 0 行，写上是为将来幂等）。
--   3) 函数不对 anon/authenticated 开放 EXECUTE —— 只由触发器调用，避免暴露成 RPC。
--
-- 注意：auth.users 的 owner 是 supabase_auth_admin，postgres 能建触发器是因为
-- Supabase 给 postgres 授了 TRIGGER 权限（已在事务内实测通过，见提交说明）。
-- 该迁移可重复执行。

begin;

-- ── 1. 桥接函数 ───────────────────────────────────────────────────────────
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  -- 显示名优先级：注册时填的 display_name → 邮箱 @ 前面 → null（不改默认值）
  v_name := nullif(btrim(coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    ''
  )), '');
  if v_name is null and new.email is not null then
    v_name := split_part(new.email, '@', 1);
  end if;

  insert into public.app_users (id, display_name)
  values (new.id, v_name)
  on conflict (id) do nothing;   -- 幂等：已存在的档案不被注册流程覆盖

  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'auth.users INSERT 后补 public.app_users 行。由触发器调用，不对外开放 EXECUTE。';

revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.handle_new_auth_user() from anon, authenticated;

-- ── 2. 触发器（重建以确保定义最新）──────────────────────────────────────
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ── 3. 回填历史用户（幂等）──────────────────────────────────────────────
insert into public.app_users (id, display_name)
select u.id,
       coalesce(
         nullif(btrim(coalesce(u.raw_user_meta_data ->> 'display_name', '')), ''),
         split_part(coalesce(u.email, ''), '@', 1),
         null
       )
from auth.users u
where not exists (select 1 from public.app_users a where a.id = u.id)
on conflict (id) do nothing;

-- ── 4. 自检 ──────────────────────────────────────────────────────────────
select '触发器 on_auth_user_created 存在'::text as item,
       (select count(*) from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'auth' and c.relname = 'users'
           and t.tgname = 'on_auth_user_created' and not t.tgisinternal)::text as actual,
       '1'::text as expect
union all
select '桥接函数为 security definer',
       (select prosecdef::text from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'handle_new_auth_user'),
       'true'
union all
select '桥接函数 anon 可执行（应 0）',
       (select count(*)::text from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'handle_new_auth_user'
           and has_function_privilege('anon', p.oid, 'EXECUTE')),
       '0'
union all
select 'auth.users 中缺 app_users 行的用户（应 0）',
       (select count(*)::text from auth.users u
         where not exists (select 1 from public.app_users a where a.id = u.id)),
       '0';

commit;
