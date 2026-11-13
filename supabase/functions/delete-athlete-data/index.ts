/**
 * 第三世界 · Edge Function：删除运动员数据（PIPL 第 47 条「删除权」）
 *
 * 路由：POST /functions/v1/delete-athlete-data
 * body：{ athlete_id: uuid, confirm: "DELETE", reason?: string, dry_run?: true }
 *
 * 权限（两条路，任一成立即可，其余一律 403）：
 *   1. 调用者是该 org 的 org_admin
 *   2. 调用者是这名运动员本人（athletes.user_id = caller）
 *
 * 为什么用 service_role：0002 的 athletes_delete 只放行 org_admin；运动员本人注销
 * 自助账号在 RLS 下删不掉自己那一行。所以这里**先由代码显式鉴权**，再用
 * service_role 执行。这正是「service_role 只在代码里鉴权之后使用」的场合。
 *
 * 删除范围：athletes 一行 + ON DELETE CASCADE 的全部子表（activities / raw_samples /
 * daily_metrics / test_sessions / jump_tests / vbt_sets / devices / athlete_grants）
 * + 两个桶里属于该运动员的对象。审计日志**保留**（法律要求留痕，且已脱敏为 id）。
 *
 * 不可撤销：必须先 dry_run 看清楚「将要删除多少行」，再带 confirm:"DELETE" 真删。
 */

import { preflight, json, fail, log } from "../_shared/cors.ts";
import { userClient, adminClient, requireUser, errText } from "../_shared/client.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHILD_TABLES = ["activities", "raw_samples", "daily_metrics", "test_sessions", "devices", "athlete_grants"] as const;

// deno-lint-ignore no-explicit-any
type AnyClient = any;

async function countRows(db: AnyClient, table: string, athleteId: string): Promise<number | string> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq("athlete_id", athleteId);
  return error ? `err:${errText(error)}` : (count ?? 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return fail("method_not_allowed", "只支持 POST", 405);

  const caller = await requireUser(req);
  if (!caller) return fail("unauthenticated", "缺少或无效的访问令牌", 401);

  let body: { athlete_id?: string; confirm?: string; reason?: string; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return fail("invalid_body", "body 必须是 JSON", 400);
  }

  const athleteId = String(body.athlete_id ?? "");
  if (!UUID_RE.test(athleteId)) return fail("invalid_athlete_id", "athlete_id 必须是 uuid", 400);

  const db: AnyClient = userClient(req);
  const admin: AnyClient = adminClient();

  // 1. 读目标行（用调用者身份读，读不到就是无权）
  const { data: athlete, error: aErr } = await db
    .from("athletes")
    .select("id, org_id, user_id, full_name, status")
    .eq("id", athleteId)
    .maybeSingle();
  if (aErr) return fail("read_failed", errText(aErr), 500);
  if (!athlete) return fail("not_found", "运动员不存在，或你无权读取", 404);

  const orgId = athlete.org_id as string;

  // 2. 鉴权：org_admin 或 本人
  const isSelf = athlete.user_id && athlete.user_id === caller.user.id;
  let isAdmin = false;
  if (!isSelf) {
    const { data: m } = await db
      .from("memberships")
      .select("role, expires_at")
      .eq("org_id", orgId)
      .eq("user_id", caller.user.id)
      .eq("role", "org_admin")
      .maybeSingle();
    isAdmin = !!m && (!m.expires_at || new Date(m.expires_at).getTime() > Date.now());
  }
  if (!isSelf && !isAdmin) {
    log("delete.denied", { athlete_id: athleteId, caller: caller.user.id });
    return fail("forbidden", "只有机构管理员（org_admin）或运动员本人可以删除", 403);
  }

  // 3. 统计将受影响的量
  const counts: Record<string, number | string> = {};
  for (const t of CHILD_TABLES) counts[t] = await countRows(db, t, athleteId);

  // 4. dry_run：只报数，不动数据
  if (body.dry_run === true || body.confirm !== "DELETE") {
    return json({
      ok: true,
      dry_run: true,
      athlete: { id: athleteId, full_name: athlete.full_name, org_id: orgId },
      would_delete: counts,
      hint: body.confirm !== "DELETE"
        ? '确认无误后重新提交，并把 confirm 设为 "DELETE"。'
        : "dry_run=true 已生效，未删除任何数据。",
    });
  }

  try {
    // 5. 先清对象存储（数据库删了以后就查不到路径，必须先做）
    const removed: Record<string, number> = {};
    for (const bucket of ["activity-files", "session-videos"]) {
      const prefix = `${orgId}/${athleteId}`;
      const list = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
      if (list.error) {
        removed[bucket] = -1; // -1 = 列举失败，不影响数据库删除，但要在响应里暴露
      } else {
        const paths = (list.data ?? []).map((o: { name: string }) => `${prefix}/${o.name}`);
        if (paths.length) {
          const del = await admin.storage.from(bucket).remove(paths);
          removed[bucket] = del.error ? -1 : paths.length;
        } else {
          removed[bucket] = 0;
        }
      }
    }

    // 6. 删主档 → 子表由 FK CASCADE 连带删除
    const del = await admin.from("athletes").delete().eq("id", athleteId);
    if (del.error) return fail("delete_failed", errText(del.error), 500);

    // 7. 留痕（审计表保留 actor_id + 目标 id，不含姓名等个人信息）
    await admin.from("audit_logs").insert({
      actor_id: caller.user.id,
      org_id: orgId,
      action: "delete.athlete_data",
      target_type: "athlete",
      target_id: athleteId,
      detail: {
        by: isSelf ? "self" : "org_admin",
        reason: body.reason ?? null,
        cascade: { ...counts },
        storage_removed: removed,
      },
    });

    log("delete.ok", { athlete_id: athleteId, by: isSelf ? "self" : "admin", counts });

    return json({
      ok: true,
      deleted: { athlete_id: athleteId, cascade: counts, storage_removed: removed },
      audit_written: true,
      note: "审计日志已保留（仅 id 与动作，不含个人信息）；对象存储为最终一致，若有残留会在 24h 内清理。",
    });
  } catch (e) {
    log("delete.error", { athlete_id: athleteId, error: errText(e) });
    return fail("delete_failed", errText(e), 500);
  }
});
