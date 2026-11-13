/**
 * 第三世界 · Edge Function：设备厂商 OAuth 回调
 *
 * 路由：GET /functions/v1/oauth-callback?code=...&state=...
 * 鉴权：**没有 JWT**（浏览器从厂商跳回来），所以 config.toml 里 verify_jwt = false。
 *       安全性由 state 的 HMAC 签名 + 10 分钟有效期保证，签名里绑定了 device_id
 *       和发起人 user_id，第三方无法伪造。
 *
 * 落库：device_credentials 全程 service_role（该表 0002 故意不建策略 = 默认拒绝），
 *       令牌用 AES-256-GCM 加密后写 bytea，密钥只在服务端环境变量 ARC_CREDENTIAL_KEY。
 *
 * 环境变量：
 *   ARC_<PROVIDER>_TOKEN_URL / _CLIENT_ID / _CLIENT_SECRET
 *   ARC_OAUTH_REDIRECT_URL / ARC_STATE_SECRET / ARC_CREDENTIAL_KEY
 *   ARC_APP_DEEPLINK   例：thirdworld://oauth/done（回调完成后重定向回去）
 */

import { json, fail, log } from "../_shared/cors.ts";
import { adminClient, errText } from "../_shared/client.ts";
import { seal, verifyState } from "../_shared/crypto.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return fail("method_not_allowed", "只支持 GET（厂商浏览器跳转）", 405);

  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const stateToken = url.searchParams.get("state") ?? "";
  const errParam = url.searchParams.get("error");

  if (errParam) {
    log("oauth.error_from_vendor", { error: errParam });
    return fail("vendor_denied", `厂商返回错误：${errParam}`, 400);
  }
  if (!code || !stateToken) return fail("missing_params", "缺少 code 或 state", 400);

  const state = await verifyState(stateToken);
  if (!state) return fail("invalid_state", "state 失效或签名不匹配（可能超过 10 分钟）", 400);

  const env = (k: string) => Deno.env.get(k)?.trim() ?? "";
  const up = state.provider.toUpperCase();
  const tokenUrl = env(`ARC_${up}_TOKEN_URL`);
  const clientId = env(`ARC_${up}_CLIENT_ID`);
  const clientSecret = env(`ARC_${up}_CLIENT_SECRET`);
  const redirectUri = env("ARC_OAUTH_REDIRECT_URL");
  const deeplink = env("ARC_APP_DEEPLINK") || "thirdworld://oauth/done";

  const missing = [
    [`ARC_${up}_TOKEN_URL`, tokenUrl],
    [`ARC_${up}_CLIENT_ID`, clientId],
    [`ARC_${up}_CLIENT_SECRET`, clientSecret],
    ["ARC_OAUTH_REDIRECT_URL", redirectUri],
    ["ARC_CREDENTIAL_KEY", env("ARC_CREDENTIAL_KEY")],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    log("oauth_callback.missing_env", { provider: state.provider, missing });
    return fail("provider_not_configured", `缺少环境变量：${missing.join(", ")}`, 501, { missing });
  }

  // 1. 换令牌
  let tokens: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      log("oauth_callback.token_http_error", { status: resp.status, provider: state.provider });
      return fail("token_exchange_failed", `厂商令牌接口返回 ${resp.status}：${text.slice(0, 300)}`, 502);
    }
    tokens = JSON.parse(text);
  } catch (e) {
    return fail("token_exchange_exception", errText(e), 502);
  }

  if (!tokens.access_token) return fail("no_access_token", "厂商未返回 access_token", 502);

  const admin = adminClient();

  // 2. 设备必须存在且属于发起人所在的授权范围（state 里带了 user_id，这里再确认一次）
  const { data: device, error: dErr } = await admin
    .from("devices")
    .select("id, org_id, athlete_id, vendor, status")
    .eq("id", state.device_id)
    .maybeSingle();
  if (dErr) return fail("read_failed", errText(dErr), 500);
  if (!device) return fail("device_not_found", "设备不存在（可能已被删除）", 404);

  const { data: m } = await admin
    .from("memberships")
    .select("role, expires_at")
    .eq("org_id", device.org_id)
    .eq("user_id", state.user_id)
    .maybeSingle();
  const stillAllowed = !!m && (!m.expires_at || new Date(m.expires_at).getTime() > Date.now());
  if (!stillAllowed) {
    log("oauth_callback.forbidden", { device_id: state.device_id, user_id: state.user_id });
    return fail("forbidden", "发起人已不在该机构，授权不予落库", 403);
  }

  // 3. 加密落库（upsert：重新授权覆盖旧令牌）
  try {
    const access = await seal(tokens.access_token, 1);
    const refresh = tokens.refresh_token ? await seal(tokens.refresh_token, 1) : null;
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;

    const upsert = await admin.from("device_credentials").upsert({
      device_id: state.device_id,
      provider: state.provider,
      access_token_cipher: access.cipher,
      refresh_token_cipher: refresh?.cipher ?? null,
      key_version: access.keyVersion,
      scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : null,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "device_id" });
    if (upsert.error) return fail("store_failed", errText(upsert.error), 500);

    await admin.from("devices").update({ status: "active", last_sync_at: new Date().toISOString() })
      .eq("id", state.device_id);

    await admin.from("audit_logs").insert({
      actor_id: state.user_id,
      org_id: device.org_id,
      action: "device.oauth_linked",
      target_type: "device",
      target_id: state.device_id,
      detail: { provider: state.provider, scopes: tokens.scope ?? null, expires_at: expiresAt },
    });

    log("oauth_callback.ok", { device_id: state.device_id, provider: state.provider });

    // 4. 回跳 App（deep link 带 device_id，客户端据此刷新设备卡片）
    const back = new URL(deeplink);
    back.searchParams.set("device_id", state.device_id);
    back.searchParams.set("provider", state.provider);
    back.searchParams.set("status", "ok");
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  } catch (e) {
    log("oauth_callback.store_exception", { error: errText(e) });
    return json({ ok: false, error: { code: "store_exception", message: errText(e) } }, 500);
  }
});
