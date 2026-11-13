/**
 * 第三世界 · Edge Function：个人信息导出（PIPL 第 45 条「查阅、复制」）
 *
 * 路由：GET|POST /functions/v1/export-athlete-data?athlete_id=<uuid>
 * 鉴权：必须带调用者 JWT；所有读取都走调用者的 RLS 身份，不用 service_role。
 * 产物：exports/{org_id}/{caller_id}/{request_id}.json + 10 分钟签名下载链接。
 *
 * 设计约束（对齐「不估算、不补造」）：
 *   · 缺测的指标原样导出 value=null / quality=missing，绝不补 0、不插值。
 *   · 信封带 schema_version 与 sha256，接收方可校验未被篡改。
 *   · 单表行数上限 MAX_ROWS，超限**报错**而不是静默截断 —— 截断的导出包
 *     在法律意义上等于「不完整的个人信息」。
 */

import { preflight, json, fail, log } from "../_shared/cors.ts";
import { userClient, requireUser, errText } from "../_shared/client.ts";
import { sha256Hex } from "../_shared/crypto.ts";

const SCHEMA_VERSION = "arc.export.v1";
const PAGE = 1000;
const MAX_ROWS = 50000;
const SIGNED_TTL_S = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
type AnyClient = any;
type Row = Record<string, unknown>;

/** 分页拉全量；命中上限抛错 */
async function fetchAll(
  db: AnyClient,
  table: string,
  columns: string,
  orderBy: string,
  build: (q: AnyClient) => AnyClient,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(db.from(table).select(columns))
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${errText(error)}`);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
    if (out.length >= MAX_ROWS) {
      throw new Error(`${table} 超过单次导出上限 ${MAX_ROWS} 行，请按时间分段导出`);
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "GET" && req.method !== "POST") return fail("method_not_allowed", "只支持 GET / POST", 405);

  const caller = await requireUser(req);
  if (!caller) return fail("unauthenticated", "缺少或无效的访问令牌", 401);

  const url = new URL(req.url);
  let athleteId = url.searchParams.get("athlete_id") ?? "";
  if (!athleteId && req.method === "POST") {
    try {
      athleteId = String((await req.json())?.athlete_id ?? "");
    } catch {
      /* 空 body → 走下面校验 */
    }
  }
  if (!UUID_RE.test(athleteId)) return fail("invalid_athlete_id", "athlete_id 必须是 uuid", 400);

  const db: AnyClient = userClient(req);

  // 1. 主档：RLS 决定可见性；看不到统一 404，不泄露「存在但无权」
  const { data: athlete, error: aErr } = await db
    .from("athletes")
    .select("id, org_id, team_id, full_name, sex, birth_date, height_cm, weight_kg, status, created_at, updated_at")
    .eq("id", athleteId)
    .maybeSingle();
  if (aErr) return fail("read_failed", errText(aErr), 500);
  if (!athlete) return fail("not_found", "运动员不存在，或你无权读取", 404);

  const orgId = athlete.org_id as string;

  try {
    // 2. 先把会话拉出来，再用 session_id 集合取子表（PostgREST 无跨表 join 过滤）
    const [activities, metrics, sessions, devices] = await Promise.all([
      fetchAll(db, "activities", "*", "started_at", (q) => q.eq("athlete_id", athleteId)),
      fetchAll(db, "daily_metrics", "*", "metric_date", (q) => q.eq("athlete_id", athleteId)),
      fetchAll(db, "test_sessions", "*", "performed_at", (q) => q.eq("athlete_id", athleteId)),
      fetchAll(db, "devices", "id, kind, vendor, model, serial, status, last_sync_at, created_at", "created_at", (q) =>
        q.eq("athlete_id", athleteId)),
    ]);

    const sessionIds = sessions.map((s) => s.id as string);
    const [jumpTests, vbtSets] = sessionIds.length
      ? await Promise.all([
        fetchAll(db, "jump_tests", "*", "session_id", (q) => q.in("session_id", sessionIds)),
        fetchAll(db, "vbt_sets", "*", "id", (q) => q.in("session_id", sessionIds)),
      ])
      : [[], []];

    // 指标口径（全表可读）：让接收方不用再问「TL 的单位是什么」
    const { data: registry } = await db
      .from("metric_registry")
      .select("metric_id, label, unit, category, formula, calc_version, tier, is_sensitive")
      .order("metric_id", { ascending: true });

    // 同意记录：RLS 只放行本人的，队友导出时为空数组（正常，不是漏项）
    const { data: consents } = await db
      .from("consents")
      .select("id, purpose, policy_version, granted_at, revoked_at, evidence")
      .order("created_at", { ascending: true });

    const data = {
      athlete,
      activities,
      daily_metrics: metrics,
      test_sessions: sessions,
      jump_tests: jumpTests,
      vbt_sets: vbtSets,
      devices,
      consents: consents ?? [],
    };

    const envelope = {
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      requested_by: caller.user.id,
      subject: { athlete_id: athleteId, org_id: orgId },
      counts: {
        activities: activities.length,
        daily_metrics: metrics.length,
        test_sessions: sessions.length,
        jump_tests: jumpTests.length,
        vbt_sets: vbtSets.length,
        devices: devices.length,
        consents: (consents ?? []).length,
      },
      metric_registry: registry ?? [],
      notes: [
        "daily_metrics.value 为 null 且 quality=missing 表示当日缺测，未补 0、未插值。",
        "tier=vendor_aligned 的指标仅作对标展示，不参与训练建议生成。",
        "consents 为空数组表示调用者不是该运动员本人（RLS 只放行本人同意记录）。",
      ],
      data,
    };

    const body = JSON.stringify(envelope);
    const digest = await sha256Hex(body);

    // 3. 落 exports 桶：路径 = {org_id}/{caller_id}/{request_id}.json
    const requestId = crypto.randomUUID();
    const objectPath = `${orgId}/${caller.user.id}/${requestId}.json`;
    const up = await db.storage.from("exports").upload(
      objectPath,
      new Blob([body], { type: "application/json" }),
      { contentType: "application/json", upsert: false },
    );
    if (up.error) return fail("upload_failed", errText(up.error), 500);

    const signed = await db.storage.from("exports").createSignedUrl(objectPath, SIGNED_TTL_S);
    if (signed.error) return fail("sign_failed", errText(signed.error), 500);

    // 4. 审计（失败不阻断导出，只在响应里标注）
    const audited = await db.from("audit_logs").insert({
      actor_id: caller.user.id,
      org_id: orgId,
      action: "export.athlete_data",
      target_type: "athlete",
      target_id: athleteId,
      detail: { request_id: requestId, object_path: objectPath, sha256: digest, counts: envelope.counts },
    });

    log("export.ok", { athlete_id: athleteId, bytes: body.length, counts: envelope.counts });

    return json({
      ok: true,
      schema_version: SCHEMA_VERSION,
      request_id: requestId,
      object_path: objectPath,
      download_url: signed.data?.signedUrl,
      expires_in: SIGNED_TTL_S,
      sha256: digest,
      bytes: body.length,
      counts: envelope.counts,
      audit_written: !audited.error,
    });
  } catch (e) {
    log("export.error", { athlete_id: athleteId, error: errText(e) });
    return fail("export_failed", errText(e), 500);
  }
});
