#!/usr/bin/env node
/**
 * 第三世界 · 本地 Mock API（仅用于开发自测，不参与上线）
 *
 * 为什么需要：真实的数据库 + RLS 已经用 tools/test-flows.mjs 验过；但浏览器走的是
 * PostgREST / GoTrue 这一层，登录门、会话持久化、数据映射、写表单这些前端逻辑
 * 在没有 publishable key 时根本跑不到。这个 mock 用固定夹具让前端整条链路可执行。
 *
 * 用法：
 *   node tools/mock-api.mjs --port 8791
 *   浏览器打开 http://127.0.0.1:8799/index.html?sburl=http://127.0.0.1:8791&sbkey=mock_publishable_key
 *   （?sburl/?sbkey 只在回环地址生效，见 supabase-client.js）
 */

import http from "node:http";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) opt[args[i].slice(2)] = args[++i];
const PORT = Number(opt.port || 8791);

const UID = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
const ATH = "33333333-3333-3333-3333-333333333333";
const EMAIL = opt.email || "demo@third.world";
const PASSWORD = opt.password || "ArcDemo2026!";

function dayOffset(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const activities = [
  { d: 1, sport: "力量", min: 64, rpe: 7 },
  { d: 2, sport: "跑步", min: 38, rpe: 4 },
  { d: 3, sport: "骑行", min: 60, rpe: 6 },
  { d: 4, sport: "力量", min: 72, rpe: 8 },
  { d: 5, sport: "跑步", min: 46, rpe: 5 },
  { d: 7, sport: "力量", min: 55, rpe: 6 },
  { d: 8, sport: "跑步", min: 104, rpe: 6 }
].map((x, i) => ({
  id: "act-" + i,
  athlete_id: ATH, org_id: ORG,
  started_at: dayOffset(x.d) + "T09:00:00+08:00",
  sport: x.sport, duration_s: x.min * 60,
  distance_m: null, training_load: x.min * x.rpe,
  load_method: "srpe", rpe: x.rpe, source: "manual"
}));

const metrics = [];
(function () {
  let ctl = null, atl = null, acu = null, chr = null;
  for (let i = 8; i >= 1; i--) {
    const day = activities.find((a) => a.started_at.slice(0, 10) === dayOffset(i));
    if (!day) continue;
    const tl = day.training_load;
    ctl = ctl === null ? tl : ctl + (tl - ctl) / 42;
    atl = atl === null ? tl : atl + (tl - atl) / 7;
    acu = acu === null ? tl : acu + 0.25 * (tl - acu);
    chr = chr === null ? tl : chr + 0.069 * (tl - chr);
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "tl.srpe", value: tl, unit: "AU", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "ctl", value: +ctl.toFixed(2), unit: "AU", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "atl", value: +atl.toFixed(2), unit: "AU", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "acwr.ewma", value: +(acu / chr).toFixed(3), unit: "ratio", quality: "ok", source: "manual" });
  }
  for (let i = 1; i <= 7; i++) {
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "sleep.tst", value: 380 + i * 9, unit: "min", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(i), metric_id: "hrv.rmssd", value: 52 + i * 2, unit: "ms", quality: "ok", source: "manual" });
  }
  // 今天（还没练）：与 0011 的真实行为一致——状态量延续，TL 不写
  if (ctl !== null) {
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(0), metric_id: "ctl", value: +ctl.toFixed(2), unit: "AU", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(0), metric_id: "atl", value: +atl.toFixed(2), unit: "AU", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(0), metric_id: "acwr.ewma", value: +(acu / chr).toFixed(3), unit: "ratio", quality: "ok", source: "manual" });
    metrics.push({ athlete_id: ATH, metric_date: dayOffset(0), metric_id: "readiness", value: 78, unit: "score", quality: "ok", source: "manual" });
  }
})();

// 服务端聚合（对应真实库的 arc_daily_summary / arc_team_overview），
// 前端只渲染这两个结构，所以 mock 也必须返回同样的形状，否则测出来的不是真路径。
const SUMMARY = {
  athlete_id: ATH,
  date: dayOffset(0),
  timezone: "Asia/Shanghai",
  load: { tl: null, ctl: 88.4, atl: 67.2, tsb: 21.2, acwr: 0.76, acwr_rolling: null, tm: null, ts: null, quality: "ok", source: "manual" },
  recovery: { rmssd: 64, lnrmssd: 4.1589, baseline: 4.1009, swc: 0.061, z: 0.95, sleep_tst: 452, sleep_debt: 118, quality: "ok" },
  readiness: { score: 78, parts: { load: 100, hrv: 74, sleep: 94 }, weights: { load: 0.35, hrv: 0.35, sleep: 0.3 }, coverage: 1, flags: [] },
  plan: [{ scheduled_date: dayOffset(0), status: "planned", title: "下肢力量 · VBT", purpose: "strength", duration_min: 68, intensity_rpe: 7 }],
  flags: [],
  missing: ["滚动 ACWR 需 7/7 与 ≥26/28 有效天，当前不足"],
  rule_version: "v1.0"
};

const TEAM_OVERVIEW = {
  org_id: ORG, team_id: null, date: dayOffset(0),
  members: 2, warn: 0, thin: 1, load7: 1766, avg_acwr: 0.76, avg_readiness: 78,
  rule_version: "v1.0",
  members_detail: [
    { id: ATH, name: "演示账号", load7: 1766, acwr: 0.76, readiness: 78, last_date: dayOffset(1), status: "ok" },
    { id: "44444444-4444-4444-4444-444444444444", name: "周 珩", load7: 0, acwr: null, readiness: null, last_date: null, status: "thin" }
  ]
};

const ATHLETES = [  { id: ATH, user_id: UID, org_id: ORG, team_id: null, full_name: "演示账号", sex: "male", status: "active", height_cm: 180, weight_kg: 74, teams: { name: "一队" } },
  { id: "44444444-4444-4444-4444-444444444444", user_id: null, org_id: ORG, team_id: null, full_name: "周 珩", sex: "male", status: "active", height_cm: 176, weight_kg: 70, teams: { name: "一队" } }
];

const REGISTRY = [
  ["tl.srpe", "训练负荷 sRPE", "AU", "load"], ["ctl", "慢性负荷 CTL", "AU", "load"],
  ["atl", "急性负荷 ATL", "AU", "load"], ["tsb", "负荷平衡 TSB", "AU", "load"],
  ["acwr.ewma", "ACWR（EWMA）", "ratio", "load"], ["acwr.rolling", "ACWR（滚动）", "ratio", "load"],
  ["tm", "训练单调性 TM", "ratio", "load"], ["ts", "训练应变 TS", "AU", "load"],
  ["hrv.rmssd", "HRV · RMSSD", "ms", "recovery"], ["sleep.tst", "总睡眠时长 TST", "min", "recovery"],
  ["jump.height", "跳跃高度（飞行时间法）", "cm", "jump"], ["jump.rsi", "反应力量指数 RSI", "m/s", "jump"],
  ["vbt.mcv", "平均向心速度 MCV", "m/s", "vbt"], ["vbt.vl", "速度损失 VL", "%", "vbt"]
].map(([metric_id, label, unit, category]) => ({
  metric_id, label, unit, category, formula: null, calc_version: "v1.0", tier: "core"
}));

const SESSIONS = [{
  id: "ts-1", athlete_id: ATH, kind: "jump", performed_at: dayOffset(1) + "T09:10:00+08:00", source: "manual",
  jump_tests: [{ jump_type: "cmj", height_cm: 32.1, contact_ms: null, flight_ms: 512, rsi: null, video_fps: 240, quality: "ok" }],
  vbt_sets: []
}];

const AUDIT = [
  { occurred_at: new Date().toISOString(), actor_id: UID, action: "activities.insert", target_type: "activities", target_id: "act-0", request_id: "rq_mock1", detail: { op: "INSERT" } },
  { occurred_at: new Date(Date.now() - 3600e3).toISOString(), actor_id: UID, action: "org.bootstrap", target_type: "org", target_id: ORG, request_id: null, detail: { org_name: "演示队" } }
];

function json(res, code, body, extra = {}) {
  const s = body === null ? "" : JSON.stringify(body);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type,prefer,x-client-info",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "content-range"
  }, extra));
  res.end(s);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, null);
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  const q = u.searchParams;
  console.log(req.method.padEnd(6) + p + (u.search || ""));

  // Auth
  if (p === "/auth/v1/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const okUser = (j.email || "").toLowerCase() === EMAIL.toLowerCase() && j.password === PASSWORD;
      if (u.searchParams.get("grant_type") === "refresh_token") {
        return json(res, 200, { access_token: "mock.access", refresh_token: "mock.refresh", expires_in: 3600, user: { id: UID, email: EMAIL } });
      }
      if (!okUser) return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      json(res, 200, { access_token: "mock.access", refresh_token: "mock.refresh", expires_in: 3600, user: { id: UID, email: EMAIL } });
    });
    return;
  }
  if (p === "/auth/v1/logout") return json(res, 204, null);
  if (p === "/auth/v1/user") {
    if (req.method === "PUT") return json(res, 200, { id: UID, email: EMAIL });
    return json(res, 200, { id: UID, email: EMAIL });
  }
  if (p === "/auth/v1/recover") return json(res, 200, {});
  if (p === "/auth/v1/signup") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => json(res, 200, { access_token: "mock.access", refresh_token: "mock.refresh", expires_in: 3600, user: { id: UID, email: JSON.parse(body || "{}").email } }));
  }

  // RPC
  if (p.startsWith("/rest/v1/rpc/")) {
    const fn = p.split("/").pop();
    if (fn === "arc_create_invite") return json(res, 200, [{ code: "MOCK8X2K", org_id: ORG, team_id: null, role: "athlete", expires_at: null, max_uses: 10 }]);
    if (fn === "arc_add_athlete") return json(res, 200, "55555555-5555-5555-5555-555555555555");
    if (fn === "arc_daily_summary") return json(res, 200, SUMMARY);
    if (fn === "arc_team_overview") return json(res, 200, TEAM_OVERVIEW);
    if (fn === "arc_active_rule") return json(res, 200, { acwr: { low: 0.8, high: 1.3, danger: 1.5 }, monotony_max: 2, strain_max: 6000 });
    return json(res, 200, ORG);
  }

  // REST
  if (p.startsWith("/rest/v1/")) {
    const table = p.split("/")[3];
    const limit = Number(q.get("limit") || 1000);
    const map = {
      app_users: () => [{ id: UID, display_name: "演示账号", locale: "zh-CN", is_minor: false }],
      memberships: () => [{ org_id: ORG, team_id: null, role: "org_admin", expires_at: null }],
      orgs: () => [{ id: ORG, name: "第三世界演示队", timezone: "Asia/Shanghai" }],
      athletes: () => ATHLETES,
      activities: () => activities,
      daily_metrics: () => metrics,
      test_sessions: () => SESSIONS,
      devices: () => [],
      audit_logs: () => AUDIT.slice(0, limit),
      metric_registry: () => REGISTRY,
      consents: () => []
    };

    if (req.method === "GET") {
      if (!map[table]) return json(res, 404, { message: "relation not found" });
      return json(res, 200, map[table]().slice(0, limit));
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        let payload = null;
        try { payload = JSON.parse(body || "null"); } catch { /* ignore */ }
        const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
        const withIds = rows.map((r, i) => Object.assign({ id: "new-" + Date.now() + "-" + i }, r));
        if (table === "activities") { activities.unshift(withIds[0]); }
        if (table === "test_sessions") { SESSIONS.unshift(withIds[0]); }
        if (table === "daily_metrics") { rows.forEach((r) => metrics.push(r)); }
        json(res, 201, /return=representation/.test(String(req.headers.prefer || "")) ? withIds : null);
      });
    }
    if (req.method === "PATCH" || req.method === "DELETE") return json(res, 204, null);
  }

  json(res, 404, { message: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nMock API 已启动：http://127.0.0.1:${PORT}`);
  console.log(`前端打开：http://127.0.0.1:8799/index.html?sburl=http://127.0.0.1:${PORT}&sbkey=mock_publishable_key`);
  console.log(`登录：${EMAIL} / ${PASSWORD}\n`);
});
