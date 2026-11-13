/**
 * 第三世界 · Edge Function：发起设备厂商 OAuth 授权（Enode / Garmin / Strava 同构）
 *
 * 路由：POST /functions/v1/device-oauth-start
 * body：{ device_id: uuid, provider: "enode" | "garmin" | "strava" }
 * 返回：{ authorize_url } —— 客户端用系统浏览器打开（不要在 WebView 里开）
 *
 * 为什么由服务端拼 URL：client_id / redirect_uri 必须与厂商后台登记的一致，
 * 放在前端容易被改；state 用 HMAC 自签，10 分钟过期，绑定 device_id + 调用者。
 *
 * 需要的环境变量（按 provider 前缀）：
 *   ARC_<PROVIDER>_AUTHORIZE_URL
 *   ARC_<PROVIDER>_CLIENT_ID
 *   ARC_OAUTH_REDIRECT_URL      例：https://<ref>.supabase.co/functions/v1/oauth-callback
 *   ARC_STATE_SECRET            至少 32 字符，用于 state 签名
 */

import { preflight, json, fail, log } from "../_shared/cors.ts";
import { userClient, requireUser, errText } from "../_shared/client.ts";
import { signState } from "../_shared/crypto.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = ["enode", "garmin", "strava"] as const;
const STATE_TTL_S = 600;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method_not_allowed", "只支持 POST", 405);

  const caller = await requireUser(req);
  if (!caller) return fail("unauthenticated", "缺少或无效的访问令牌", 401);

  let body: { device_id?: string; provider?: string };
  try {
    body = await req.json();
  } catch {
    return fail("invalid_body", "body 必须是 JSON", 400);
  }

  const deviceId = String(body.device_id ?? "");
  const provider = String(body.provider ?? "").toLowerCase();
  if (!UUID_RE.test(deviceId)) return fail("invalid_device_id", "device_id 必须是 uuid", 400);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    return fail("invalid_provider", `provider 只支持 ${PROVIDERS.join(" / ")}`, 400);
  }

  const db = userClient(req);

  // RLS 判定：只有能写该运动员设备的人才允许绑定（devices_select 已按 org + 运动员过滤）
  const { data: device, error } = await db
    .from("devices")
    .select("id, org_id, athlete_id, vendor, status")
    .eq("id", deviceId)
    .maybeSingle();
  if (error) return fail("read_failed", errText(error), 500);
  if (!device) return fail("not_found", "设备不存在，或你无权绑定", 404);

  const env = (k: string) => Deno.env.get(k)?.trim() ?? "";
  const up = provider.toUpperCase();
  const authorizeUrl = env(`ARC_${up}_AUTHORIZE_URL`);
  const clientId = env(`ARC_${up}_CLIENT_ID`);
  const redirectUri = env("ARC_OAUTH_REDIRECT_URL");

  const missing = [
    ["ARC_" + up + "_AUTHORIZE_URL", authorizeUrl],
    ["ARC_" + up + "_CLIENT_ID", clientId],
    ["ARC_OAUTH_REDIRECT_URL", redirectUri],
    ["ARC_STATE_SECRET", env("ARC_STATE_SECRET")],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    log("oauth_start.missing_env", { provider, missing });
    return fail("provider_not_configured", `该厂商尚未配置，缺少环境变量：${missing.join(", ")}`, 501, { missing });
  }

  const state = await signState({
    device_id: deviceId,
    provider,
    user_id: caller.user.id,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_S,
    nonce: crypto.randomUUID(),
  });

  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // 不同厂商 scope 名称不同，统一用 ARC_<PROVIDER>_SCOPE 覆盖
  const scope = env(`ARC_${up}_SCOPE`);
  if (scope) url.searchParams.set("scope", scope);

  log("oauth_start.ok", { device_id: deviceId, provider, caller: caller.user.id });

  return json({
    ok: true,
    provider,
    device_id: deviceId,
    authorize_url: url.toString(),
    state_ttl_s: STATE_TTL_S,
    note: "请用系统浏览器打开 authorize_url；回调由 oauth-callback 处理，客户端只需监听 deep link。",
  });
});
