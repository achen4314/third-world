/**
 * 第三世界 · Edge Function 共享：CORS 与统一 JSON 响应
 *
 * 允许来源默认 *（原型阶段：本地 file:// / localhost / 预览域名混用）。
 * 上线前必须改成白名单：ARC_ALLOWED_ORIGIN=https://app.example.com
 */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("ARC_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-arc-confirm",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

export function fail(code: string, message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: { code, message, ...extra } }, status);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** 极简请求日志：不打印令牌、不打印正文 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
}
