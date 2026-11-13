#!/usr/bin/env node
/**
 * 第三世界 · 账号管理（服务端运维用，走数据库连接，不依赖邮件服务）
 *
 * 为什么需要它：
 *   Supabase 默认「邮箱确认」是开的。项目没配 SMTP 时，注册会成功但确认邮件发不出去，
 *   用户就永远登录不了 —— 这是「真实用户可注册」最常见的卡点。
 *   本脚本用管理身份直接建一个已确认账号，绕过邮件依赖，用于试点与验收。
 *
 * 用法：
 *   node tools/accounts.mjs list
 *   node tools/accounts.mjs create --email demo@third.world --password 'xxxx' --name 演示账号 [--org 演示队] [--role org_admin|athlete]
 *   node tools/accounts.mjs confirm --email someone@x.com     # 把已注册但未确认的账号标记为已确认
 *   node tools/accounts.mjs passwd  --email someone@x.com --password 'newpass123'
 *
 * 说明：create 会同时建 organizations / memberships / athletes（等价于 App 内「开通」流程），
 *       因此建完即可直接登录看到有数据的界面。
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readEnv() {
  const env = {};
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) throw new Error("缺少 .env.local");
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const args = process.argv.slice(2);
const cmd = args[0] || "list";
const opt = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    opt[k] = v;
  }
}

const env = readEnv();
const c = new pg.Client({
  connectionString: env.DIRECT_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000
});
await c.connect();

const q = (sql, p) => c.query(sql, p);
const one = async (sql, p) => (await c.query(sql, p)).rows[0];

async function list() {
  const r = await q(`
    select u.email,
           (u.email_confirmed_at is not null) as confirmed,
           u.created_at::date as created,
           a.display_name,
           coalesce(string_agg(distinct m.role::text, ','), '—') as roles,
           coalesce(string_agg(distinct o.name, ','), '—') as orgs
    from auth.users u
    left join public.app_users a on a.id = u.id
    left join public.memberships m on m.user_id = u.id
    left join public.orgs o on o.id = m.org_id
    group by u.email, u.email_confirmed_at, u.created_at, a.display_name
    order by u.created_at desc
    limit 100`);
  if (!r.rows.length) { console.log("（还没有任何账号）"); return; }
  console.log("\n邮箱".padEnd(34) + "已确认".padEnd(8) + "称呼".padEnd(14) + "角色".padEnd(14) + "组织");
  console.log("─".repeat(96));
  for (const x of r.rows) {
    console.log(
      String(x.email).padEnd(34) +
      (x.confirmed ? "是" : "否").padEnd(8) +
      String(x.display_name || "—").padEnd(14) +
      String(x.roles).padEnd(14) +
      String(x.orgs)
    );
  }
  console.log("");
}

async function create() {
  const email = String(opt.email || "").trim().toLowerCase();
  const password = String(opt.password || "");
  const name = String(opt.name || email.split("@")[0]);
  const role = String(opt.role || "org_admin");
  const orgName = opt.org || (name + " 的团队");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--email 不合法");
  if (password.length < 8) throw new Error("--password 至少 8 位");
  if (!["org_admin", "athlete", "coach"].includes(role)) throw new Error("--role 只支持 org_admin / coach / athlete");

  await q("begin");
  try {
    const exist = await one("select id, email_confirmed_at from auth.users where lower(email) = $1", [email]);
    let uid;
    if (exist) {
      uid = exist.id;
      await q(
        `update auth.users
            set encrypted_password = crypt($2, gen_salt('bf')),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                updated_at = now(),
                raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name', $3::text)
          where id = $1`,
        [uid, password, name]
      );
      console.log(`  账号已存在，重置密码并确认：${email}`);
    } else {
      const r = await one(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                                 created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
         values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
                 $1, crypt($2, gen_salt('bf')), now(), now(), now(),
                 '{"provider":"email","providers":["email"]}'::jsonb,
                 jsonb_build_object('display_name', $3::text))
         returning id`,
        [email, password, name]
      );
      uid = r.id;
      await q(
        `insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
         values (gen_random_uuid(), $1::uuid, $2::text, 'email',
                 jsonb_build_object('sub', $2::text, 'email', $3::text, 'email_verified', true), now(), now(), now())`,
        [uid, uid, email]
      );
      console.log(`  已创建并确认账号：${email}`);
    }

    // 开通组织（幂等：已有成员关系就跳过）
    const mem = await one("select org_id from public.memberships where user_id = $1 limit 1", [uid]);
    if (mem) {
      console.log(`  已有组织（${mem.org_id}），跳过开通`);
    } else {
      await q(
        `insert into public.app_users (id, display_name) values ($1, $2)
         on conflict (id) do update set display_name = excluded.display_name`,
        [uid, name]
      );
      const org = await one(
        `insert into public.orgs (name, slug) values ($1, $2) returning id`,
        [orgName, "demo-" + uid.slice(0, 8)]
      );
      const team = await one(`insert into public.teams (org_id, name) values ($1, '一队') returning id`, [org.id]);
      await q(
        `insert into public.memberships (org_id, team_id, user_id, role, granted_by) values ($1, null, $2, $3::app_role, $2)`,
        [org.id, uid, role]
      );
      if (role === "athlete" || opt.athlete === "true") {
        await q(
          `insert into public.athletes (org_id, team_id, user_id, full_name) values ($1, $2, $3, $4)`,
          [org.id, team.id, uid, name]
        );
      }
      console.log(`  已开通组织：${orgName}（${org.id}），角色 ${role}`);
    }
    await q("commit");
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

async function confirm() {
  const email = String(opt.email || "").trim().toLowerCase();
  const r = await one(
    `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
      where lower(email) = $1 returning id, email, email_confirmed_at`,
    [email]
  );
  if (!r) throw new Error("找不到该邮箱：" + email);
  console.log(`已确认：${r.email}（${r.email_confirmed_at.toISOString()}）`);
}

async function passwd() {
  const email = String(opt.email || "").trim().toLowerCase();
  const password = String(opt.password || "");
  if (password.length < 8) throw new Error("--password 至少 8 位");
  const r = await one(
    `update auth.users set encrypted_password = crypt($2, gen_salt('bf')), updated_at = now()
      where lower(email) = $1 returning email`,
    [email, password]
  );
  if (!r) throw new Error("找不到该邮箱：" + email);
  console.log(`已重置密码：${r.email}`);
}

try {
  if (cmd === "list") await list();
  else if (cmd === "create") await create();
  else if (cmd === "confirm") await confirm();
  else if (cmd === "passwd") await passwd();
  else {
    console.log("用法：node tools/accounts.mjs [list|create|confirm|passwd] [--email --password --name --org --role]");
  }
} finally {
  await c.end();
}
