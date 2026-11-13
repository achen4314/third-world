/**
 * 第三世界 · Edge Function 共享：Supabase 客户端与调用者身份
 *
 * 两种客户端，用途严格区分：
 *   userClient(req)  带调用者 JWT，**所有查询走 RLS** —— 默认用它
 *   adminClient()    service_role，绕过 RLS —— 只在「已经由代码显式鉴权」之后用
 *
 * 约定：任何函数都不接受客户端传来的 org_id / user_id 作为权限依据，
 * 一律从 JWT（auth.getUser）或数据库里的行推出来。
 */

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(URL_, ANON, {
    global: { headers: auth ? { Authorization: auth } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminClient(): SupabaseClient {
  if (!SERVICE) throw new Error("SUPABASE_SERVICE_ROLE_KEY 未注入");
  return createClient(URL_, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Caller = { user: User; token: string };

/** 校验 JWT；失败返回 null（由调用方决定回 401 的文案） */
export async function requireUser(req: Request): Promise<Caller | null> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await userClient(req).auth.getUser(token);
  if (error || !data?.user) return null;
  return { user: data.user, token };
}

/** 错误对象统一转成可读字符串（Supabase 的 error 不是 Error 实例） */
export function errText(e: unknown): string {
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  const any = e as { message?: string; code?: string; details?: string };
  return [any.code, any.message, any.details].filter(Boolean).join(" | ") || JSON.stringify(e);
}
