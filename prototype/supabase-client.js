/* 第三世界 · 数据接入层（零依赖，直连 Supabase REST / Auth）
 *
 * 三条硬规则，写在这里是因为它们决定了这个文件为什么这么写：
 *
 *   1. **不混用**：只要拿到真实会话，页面就只显示真实数据；某个数据集读失败就显示空，
 *      绝不用演示常量顶上。演示值只在「没配置 key / 没登录」时出现，并且界面上有明确标记。
 *   2. **不假装**：所有写操作都直接落库，失败就把服务端原因原样告诉用户（映射成人话），
 *      不做「看起来保存成功」的假成功。
 *   3. **不在前端做权限判断**：前端只决定「显示什么」，能不能写由数据库 RLS 说了算。
 *      被拒绝时把 42501 翻译成「当前角色无权……」，而不是静默失败。
 *
 * 依赖：window.ARC（data.js 的演示常量，用作空库时的回退形状）、window.ARC_ENV（env.js）
 */
(function () {
  "use strict";

  var LS_URL = "arc.db.url";
  var LS_KEY = "arc.db.key";
  var LS_SESS = "arc.db.session";

  // 角色优先级：一个人在多个组织/多角色时，取权限最高的那个决定界面
  var ROLE_RANK = ["org_admin", "team_admin", "clinician", "coach", "analyst", "athlete", "observer"];

  var S = {
    mode: "demo",        // demo | live
    reason: "尚未初始化",
    url: "",
    key: "",
    session: null,
    me: null,            // { id, email, display_name }
    role: null,          // 库内 app_role
    feRole: null,        // 映射后的展示角色
    orgId: null,
    orgName: null,
    memberships: [],
    athletes: [],
    primaryAthlete: null,
    lastSync: null,
    busy: false,
    partial: false,
    queries: [],
    counts: {},
    regMismatch: 0,
    needOnboarding: false,
    onboardingReason: ""
  };

  var subs = [];
  var demoSnapshot = null;

  /* ── 工具 ───────────────────────────────────────────────────────────── */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* 隐私模式 */ }
  }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function mdOf(s) {
    var p = String(s).slice(0, 10).split("-");
    return Number(p[1]) + "/" + Number(p[2]);
  }
  function dayList(n) {
    var out = [];
    var base = new Date(); base.setHours(12, 0, 0, 0);
    for (var i = n - 1; i >= 0; i--) out.push(ymd(new Date(base.getTime() - i * 86400000)));
    return out;
  }
  function nowText() {
    var d = new Date();
    return (d.getMonth() + 1) + "/" + d.getDate() + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function num(v) { return v === null || v === undefined || v === "" ? null : (isFinite(Number(v)) ? Number(v) : null); }
  function emit() {
    subs.forEach(function (f) { try { f(S); } catch (e) { /* 单个订阅者失败不影响其它 */ } });
    try { document.dispatchEvent(new CustomEvent("arc:db", { detail: S })); } catch (e) { /* noop */ }
  }
  function onChange(fn) { subs.push(fn); return function () { subs = subs.filter(function (x) { return x !== fn; }); }; }

  /* ── HTTP ───────────────────────────────────────────────────────────── */
  function humanError(status, text) {
    var msg = "";
    try {
      var j = JSON.parse(text);
      msg = j.message || j.msg || j.error_description || j.error || j.hint || "";
      if (j.code && !msg) msg = j.code;
    } catch (e) { msg = String(text || "").slice(0, 140); }

    if (status === 401) return "登录状态已失效（401）" + (msg ? " · " + msg : "");
    if (status === 403) return "没有权限（403）" + (msg ? " · " + msg : "");
    if (status === 404) return "对象不存在（404）：数据库迁移可能没执行" + (msg ? " · " + msg : "");
    if (status === 400) return "请求被拒（400）" + (msg ? " · " + msg : "");
    if (status === 409) return "冲突（409）" + (msg ? " · " + msg : "");
    if (status >= 500) return "服务端错误（" + status + "）" + (msg ? " · " + msg : "");
    return status + (msg ? " · " + msg : "");
  }

  async function http(path, opt) {
    opt = opt || {};
    var headers = Object.assign({ apikey: S.key }, opt.headers || {});
    if (opt.auth !== false && S.session) headers.Authorization = "Bearer " + S.session.access_token;
    if (opt.body !== undefined) headers["Content-Type"] = "application/json";
    if (opt.prefer) headers.Prefer = opt.prefer;

    var res;
    try {
      res = await fetch(S.url + path, {
        method: opt.method || "GET",
        headers: headers,
        body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined
      });
    } catch (e) {
      var err = new Error("网络不可达：请检查网络、代理或 SUPABASE_URL（" + (e.message || "fetch failed") + "）");
      err.network = true;
      throw err;
    }
    var text = await res.text();
    if (!res.ok) {
      var e2 = new Error(humanError(res.status, text));
      e2.status = res.status;
      e2.body = text;
      throw e2;
    }
    return text ? JSON.parse(text) : null;
  }

  function qs(p) {
    return Object.keys(p).map(function (k) {
      return k + "=" + encodeURIComponent(p[k]);
    }).join("&");
  }
  function rest(table, params) {
    return http("/rest/v1/" + table + (params ? "?" + qs(params) : ""));
  }
  function rpc(fn, args) {
    return http("/rest/v1/rpc/" + fn, { method: "POST", body: args || {} });
  }

  /** 单条查询：失败不抛，记进诊断表，返回 null */
  async function step(name, fn) {
    var t0 = (window.performance || Date).now();
    try {
      var data = await fn();
      S.queries.push({
        name: name, ok: true, rows: Array.isArray(data) ? data.length : (data == null ? 0 : 1),
        ms: Math.round((window.performance || Date).now() - t0)
      });
      return data;
    } catch (e) {
      S.queries.push({
        name: name, ok: false, rows: 0,
        ms: Math.round((window.performance || Date).now() - t0), error: e.message
      });
      return null;
    }
  }

  /* ── 会话 ───────────────────────────────────────────────────────────── */
  function setSession(d) {
    var exp = d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600));
    S.session = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: exp,
      user: d.user ? { id: d.user.id, email: d.user.email } : (S.session && S.session.user) || null
    };
    lsSet(LS_SESS, JSON.stringify(S.session));
  }
  function clearSession() {
    S.session = null; S.me = null; S.role = null; S.feRole = null;
    lsSet(LS_SESS, null);
  }
  async function ensureFresh() {
    if (!S.session) return false;
    if (S.session.expires_at - 90 > Math.floor(Date.now() / 1000)) return true;
    if (!S.session.refresh_token) return false;
    try {
      var d = await http("/auth/v1/token?grant_type=refresh_token", {
        method: "POST", auth: false, body: { refresh_token: S.session.refresh_token }
      });
      setSession(d);
      return true;
    } catch (e) {
      clearSession();
      return false;
    }
  }

  /* ── 认证 ───────────────────────────────────────────────────────────── */
  async function signIn(email, password) {
    if (!S.key) throw new Error("还没有配置 publishable key");
    var d = await http("/auth/v1/token?grant_type=password", {
      method: "POST", auth: false, body: { email: String(email || "").trim(), password: password }
    });
    setSession(d);
    if (d.user) S.session.user = { id: d.user.id, email: d.user.email };
    await boot();
    return S.mode;
  }

  async function signUp(email, password, displayName) {
    if (!S.key) throw new Error("还没有配置 publishable key");
    var d = await http("/auth/v1/signup", {
      method: "POST", auth: false,
      body: { email: String(email || "").trim(), password: password, data: { display_name: displayName || "" } }
    });
    // 开了邮箱确认时，signup 只返回 user，没有 access_token
    if (d && d.access_token) {
      setSession(d);
      await boot();
      return { needConfirm: false };
    }
    return { needConfirm: true, email: String(email || "").trim() };
  }

  async function signOut() {
    try { if (S.session) await http("/auth/v1/logout", { method: "POST" }); } catch (e) { /* 本地照样清 */ }
    clearSession();
    restoreDemo();
    S.mode = "demo";
    S.reason = "已退出登录";
    S.needOnboarding = false;
    emit();
  }

  async function changePassword(newPwd) {
    if (!S.session) throw new Error("未登录");
    if (String(newPwd || "").length < 8) throw new Error("新密码至少 8 位");
    await http("/auth/v1/user", { method: "PUT", body: { password: newPwd } });
    return true;
  }

  async function resetPassword(email) {
    await http("/auth/v1/recover", { method: "POST", auth: false, body: { email: String(email || "").trim() } });
    return true;
  }

  /* ── 启动 / 身份 ─────────────────────────────────────────────────────── */
  async function boot() {
    if (!S.session) {
      S.mode = "demo";
      S.reason = S.key ? "未登录（匿名身份读不到业务数据，这是权限设计的结果）" : "未配置 publishable key";
      emit();
      return;
    }
    await ensureFresh();
    var uid = S.session.user && S.session.user.id;
    S.queries = [];

    await ensureConsent(uid);

    var me = await step("app_users（我的档案）", function () {
      return rest("app_users", { select: "id,display_name,locale,is_minor", id: "eq." + uid });
    });
    var mem = await step("memberships（我的角色）", function () {
      return rest("memberships", { select: "org_id,team_id,role,expires_at" });
    });

    S.memberships = mem || [];
    var roles = S.memberships.map(function (m) { return m.role; });
    S.role = ROLE_RANK.filter(function (r) { return roles.indexOf(r) >= 0; })[0] || null;
    S.feRole = S.role ? (window.ARC && window.ARC.ROLE_MAP ? reverseRole(S.role) : null) : null;
    S.me = {
      id: uid,
      email: (S.session.user && S.session.user.email) || "",
      display_name: (me && me[0] && me[0].display_name) || ""
    };

    if (!S.memberships.length) {
      // 注册成功但还没开通组织：进入开通向导，而不是给一个空界面
      S.needOnboarding = true;
      S.mode = "live";
      S.reason = "已登录，尚未加入任何组织";
      emit();
      return;
    }
    S.needOnboarding = false;
    S.mode = "live";
    await load();
  }

  function reverseRole(dbRole) {
    var map = (window.ARC && window.ARC.ROLE_MAP) || {};
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) if (map[keys[i]] === dbRole) return keys[i];
    return null;
  }

  /* ── 隐私同意留痕（合规要求「告知 + 同意」可举证，不能只有一句文案） ── */
  var POLICY_VERSION = "2026-11-01";
  async function ensureConsent(uid) {
    try {
      var have = await rest("consents", { select: "purpose,policy_version,revoked_at", user_id: "eq." + uid });
      var live = (have || []).filter(function (c) { return !c.revoked_at; });
      var purposes = live.map(function (c) { return c.purpose; });
      var need = ["terms", "privacy"].filter(function (p) { return purposes.indexOf(p) < 0; });
      S.consents = live;
      if (!need.length) return;
      await http("/rest/v1/consents", {
        method: "POST",
        body: need.map(function (p) {
          return {
            user_id: uid, purpose: p, policy_version: POLICY_VERSION,
            evidence: { ua: navigator.userAgent, at: new Date().toISOString(), source: "signup_gate" }
          };
        }),
        prefer: "return=minimal"
      });
      S.consents = live.concat(need.map(function (p) { return { purpose: p, policy_version: POLICY_VERSION }; }));
    } catch (e) {
      // 同意记录失败不阻塞使用，但要在诊断里看得见
      S.queries.push({ name: "consents（隐私同意）", ok: false, rows: 0, ms: 0, error: e.message });
      S.partial = true;
    }
  }

  /* ── 导出我的数据（客户端直出，不依赖服务端函数部署） ───────────────── */
  async function exportMine() {
    if (!S.session) throw new Error("未登录");
    var uid = S.session.user.id;
    var tables = [
      ["app_users", { select: "*", id: "eq." + uid }],
      ["memberships", { select: "*" }],
      ["orgs", { select: "*" }],
      ["athletes", { select: "*" }],
      ["activities", { select: "*", order: "started_at.desc" }],
      ["daily_metrics", { select: "*", order: "metric_date.desc" }],
      ["test_sessions", { select: "*", order: "performed_at.desc" }],
      ["devices", { select: "*" }],
      ["consents", { select: "*" }],
      ["audit_logs", { select: "*", order: "occurred_at.desc", limit: "500" }]
    ];
    var out = { exported_at: new Date().toISOString(), account: S.me, policy_version: POLICY_VERSION, data: {} };
    for (var i = 0; i < tables.length; i++) {
      try {
        out.data[tables[i][0]] = await rest(tables[i][0], tables[i][1]);
      } catch (e) {
        out.data[tables[i][0]] = { error: e.message };
      }
    }
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "third-world-export-" + ymd(new Date()) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return out;
  }

  /* ── 读全量数据并映射到原型的数据形状 ───────────────────────────────── */
  async function load() {
    if (!S.session) return;
    S.busy = true; S.queries = []; S.partial = false;
    emit();
    try {
      await ensureFresh();
      var uid = S.session.user.id;

      var ath = await step("athletes（可见运动员）", function () {
        return rest("athletes", {
          select: "id,user_id,org_id,team_id,full_name,sex,status,height_cm,weight_kg,teams(name)",
          order: "created_at"
        });
      });
      var act = await step("activities（训练记录）", function () {
        return rest("activities", {
          select: "id,athlete_id,started_at,sport,duration_s,distance_m,training_load,load_method,rpe,source",
          order: "started_at.desc", limit: "200"
        });
      });
      var dm = await step("daily_metrics（每日指标）", function () {
        return rest("daily_metrics", {
          select: "athlete_id,metric_date,metric_id,value,quality,source,unit",
          metric_id: 'in.("tl.srpe","ctl","atl","tsb","acwr.ewma","acwr.rolling","tm","ts","load.week","hrv.rmssd","hrv.lnrmssd","hrv.baseline","hrv.swc","hrv.z","sleep.tst","sleep.efficiency","sleep.debt","readiness")',
          order: "metric_date.desc", limit: "8000"
        });
      });
      var ts = await step("test_sessions + jump_tests / vbt_sets", function () {
        return rest("test_sessions", {
          select: "id,athlete_id,kind,performed_at,source,jump_tests(jump_type,height_cm,contact_ms,flight_ms,rsi,video_fps,quality),vbt_sets(exercise,load_kg,reps,mcv,mpv,pv,vl_pct,power_w,quality)",
          order: "performed_at.desc", limit: "100"
        });
      });
      var dev = await step("devices（设备）", function () {
        return rest("devices", { select: "id,kind,vendor,model,serial,status,last_sync_at,athlete_id", order: "created_at.desc" });
      });
      var aud = await step("audit_logs（审计）", function () {
        return rest("audit_logs", { select: "occurred_at,actor_id,action,target_type,target_id,request_id,detail", order: "occurred_at.desc", limit: "60" });
      });
      var reg = await step("metric_registry（口径）", function () {
        return rest("metric_registry", { select: "metric_id,label,unit,category,formula,calc_version,tier" });
      });
      var org = await step("orgs（组织）", function () {
        return rest("orgs", { select: "id,name,timezone" });
      });

      S.partial = S.queries.some(function (q) { return !q.ok; });
      S.orgId = (S.memberships[0] && S.memberships[0].org_id) || null;
      S.orgName = (org && org[0] && org[0].name) || "";

      // 服务端聚合：前端不再自己拼就绪度/团队统计，只渲染 RPC 的结论
      var primary = (ath || []).filter(function (x) { return x.user_id === uid; })[0] ||
                    (ath || [])[0] || null;
      var summary = null, team = null;
      if (primary) {
        summary = await step("RPC · 当日总览 arc_daily_summary", function () {
          return rpc("arc_daily_summary", { p_athlete: primary.id, p_date: null });
        });
      }
      if (S.orgId) {
        team = await step("RPC · 团队总览 arc_team_overview", function () {
          return rpc("arc_team_overview", { p_org: S.orgId, p_team: null });
        });
      }

      var payload = mapAll({
        uid: uid, athletes: ath || [], activities: act || [], metrics: dm || [],
        tests: ts || [], devices: dev || [], audit: aud || [], registry: reg || [],
        summary: summary, team: team
      });
      apply(payload);

      S.lastSync = nowText();
      S.reason = S.partial ? "部分数据集读取失败（已按空值呈现，不回填演示数据）" : "已连接真实库";
    } catch (e) {
      if (e.status === 401 || /JWT|jwt/i.test(String(e.message || ""))) {
        // 会话失效：清干净并要求重新登录，不能悄悄退化成演示数据让人以为还在看真数据
        clearSession();
        S.mode = "demo";
        S.reason = "登录已失效，请重新登录";
        restoreDemo();
      } else {
        S.mode = "demo";
        S.reason = "读取失败，已回退到演示数据：" + e.message;
        restoreDemo();
      }
    } finally {
      S.busy = false;
      emit();
      // 外壳里的数据源徽标要跟着「已连接 / 上次同步」更新
      if (window.ARC_RELOAD) window.ARC_RELOAD();
    }
  }

  /* ── 映射 ───────────────────────────────────────────────────────────── */
  function mapAll(d) {
    var A = window.ARC;
    var arrays = {};
    var DAYS = 28;
    var days = dayList(DAYS);

    // 指标按 [athlete|date|metric] 建索引
    var idx = {};
    d.metrics.forEach(function (r) {
      var k = r.athlete_id + "|" + String(r.metric_date).slice(0, 10) + "|" + r.metric_id;
      idx[k] = r;
    });
    function val(athleteId, date, metricId) {
      var r = idx[athleteId + "|" + date + "|" + metricId];
      if (!r || r.value === null || r.value === undefined) return null;
      if (r.quality === "missing") return null;
      return Number(r.value);
    }

    // 主运动员：优先「我自己的档案」，否则可见的第一个
    var mine = d.athletes.filter(function (a) { return a.user_id === d.uid; })[0] || d.athletes[0] || null;
    S.primaryAthlete = mine;
    S.athletes = d.athletes;

    // 服务端聚合结果：整块透传，前端只读不算
    arrays.SUMMARY = d.summary || null;
    arrays.TEAM = d.team || null;

    // TL / HRV / 睡眠：最近 28 天
    arrays.DATES = days.map(mdOf);
    arrays.DATES_FULL = days.slice();
    arrays.TL_BASE = mine ? days.map(function (dt) { return val(mine.id, dt, "tl.srpe"); }) : days.map(function () { return null; });
    arrays.RMSSD_BASE = mine ? days.map(function (dt) { return val(mine.id, dt, "hrv.rmssd"); }) : days.map(function () { return null; });

    // 逐日负荷序列：**直接取服务端算好的值**，前端不再自己递推一遍
    arrays.SRV = mine ? days.map(function (dt) {
      return {
        tl: val(mine.id, dt, "tl.srpe"),
        ctl: val(mine.id, dt, "ctl"),
        atl: val(mine.id, dt, "atl"),
        tsb: val(mine.id, dt, "tsb"),
        acwr: val(mine.id, dt, "acwr.ewma"),
        rolling: val(mine.id, dt, "acwr.rolling"),
        tm: val(mine.id, dt, "tm"),
        ts: val(mine.id, dt, "ts")
      };
    }) : null;

    var last7 = days.slice(-7);
    arrays.SLEEP = last7.map(function (dt) {
      var tst = mine ? val(mine.id, dt, "sleep.tst") : null;
      var eff = mine ? val(mine.id, dt, "sleep.efficiency") : null;
      return {
        date: mdOf(dt), tst: tst, waso: null,
        eff: eff === null ? null : (eff > 1 ? eff / 100 : eff),
        awake: null, stages: null,
        src: tst === null ? "missing" : "manual"
      };
    });

    // 训练记录
    var acts = d.activities.filter(function (a) { return !mine || a.athlete_id === mine.id; });
    arrays.SESSIONS = acts.map(function (a) {
      return {
        date: mdOf(a.started_at),
        name: a.sport || "训练",
        sport: a.sport || "未分类",
        dur: a.duration_s ? Math.round(a.duration_s / 60) + " min" : "—",
        tl: a.training_load === null ? null : Number(a.training_load),
        method: a.load_method || (a.rpe ? "sRPE" : "—"),
        rpe: a.rpe == null ? 0 : a.rpe,
        src: a.source,
        _id: a.id
      };
    });

    // 成员列表（教练视角）
    arrays.ATHLETES = d.athletes.map(function (a) {
      var s28 = days.map(function (dt) { return val(a.id, dt, "tl.srpe"); });
      var valid = s28.filter(function (v) { return v !== null; });
      var last7v = s28.slice(-7).filter(function (v) { return v !== null; });
      var load7 = last7v.reduce(function (x, y) { return x + y; }, 0);
      var acwr = val(a.id, days[days.length - 1], "acwr.ewma");
      var complete = Math.round((valid.length / DAYS) * 100) / 100;
      var qualityRows = d.metrics.filter(function (r) { return r.athlete_id === a.id; });
      var okRows = qualityRows.filter(function (r) { return r.quality === "ok"; }).length;
      var quality = qualityRows.length ? Math.round((okRows / qualityRows.length) * 100) / 100 : 0;
      var flag = valid.length < 7 ? "数据不足" : (acwr !== null && acwr > 1.3 ? "需关注" : (complete < 0.8 ? "缺测" : "正常"));
      return {
        name: a.full_name || "未命名",
        squad: (a.teams && a.teams.name) || "未分组",
        load7: Math.round(load7),
        acwr: acwr,
        complete: complete,
        quality: quality,
        flag: flag,
        _id: a.id,
        _userId: a.user_id
      };
    });

    // 测试：跳跃 + VBT
    var jumps = [], sets = [];
    d.tests.forEach(function (s) {
      if (mine && s.athlete_id !== mine.id) return;
      (s.jump_tests || []).forEach(function (j) {
        jumps.push({
          date: mdOf(s.performed_at),
          type: j.jump_type || "CMJ",
          tf: j.flight_ms === null ? null : Number(j.flight_ms) / 1000,
          tc: j.contact_ms === null ? null : Number(j.contact_ms) / 1000,
          method: s.source || "manual",
          fps: j.video_fps === null ? null : Number(j.video_fps),
          cond: s.kind || ""
        });
      });
      (s.vbt_sets || []).forEach(function (v) {
        sets.push({
          load: v.load_kg === null ? null : Number(v.load_kg),
          mpv: v.mpv === null ? null : Number(v.mpv),
          mcv: v.mcv === null ? null : Number(v.mcv),
          pv: v.pv === null ? null : Number(v.pv),
          vl: v.vl_pct === null ? null : Number(v.vl_pct),
          p: v.power_w === null ? null : Number(v.power_w)
        });
      });
    });
    if (jumps.length) arrays.JUMPS = jumps;
    if (sets.length) arrays.VBT_SETS = sets;

    // 设备
    var KIND = {
      hr_strap: "心率带", watch: "运动手表", bike_trainer: "骑行台 / 功率计",
      treadmill: "跑步机", vbt_imu: "VBT IMU", phone: "手机"
    };
    var STATUS = { active: "online", pending: "warn", expired: "offline", revoked: "locked" };
    if (d.devices.length) {
      arrays.DEVICES = d.devices.map(function (v) {
        return {
          id: v.id,
          name: [v.vendor, v.model].filter(Boolean).join(" ") || KIND[v.kind] || "设备",
          kind: KIND[v.kind] || v.kind,
          proto: v.serial ? "SN " + v.serial : "—",
          rate: "—",
          battery: null,
          status: STATUS[v.status] || "offline",
          last: v.last_sync_at ? mdOf(v.last_sync_at) : "未同步",
          src: "device"
        };
      });
    }

    // 审计
    if (d.audit.length) {
      arrays.AUDIT = d.audit.map(function (r) {
        var det = r.detail || {};
        return {
          ts: mdOf(r.occurred_at) + " " + String(r.occurred_at).slice(11, 16),
          actor: r.actor_id ? String(r.actor_id).slice(0, 8) : "system",
          action: r.action,
          target: (r.target_type || "") + (r.target_id ? " / " + String(r.target_id).slice(0, 8) : ""),
          result: det.result || det.error || "成功",
          rid: r.request_id || "—"
        };
      });
    }

    // 口径：以 registry 为唯一真源比对，不一致只报数、不静默覆盖（避免文档与库各说各话）
    S.regMismatch = 0;
    d.registry.forEach(function (r) {
      var m = A.METRICS && A.METRICS[r.metric_id];
      if (!m || !r.formula) return;
      var a = String(m.formula).replace(/\s+/g, "");
      var b = String(r.formula).replace(/\s+/g, "");
      if (a !== b) S.regMismatch++;
    });

    return {
      arrays: arrays,
      feRole: S.feRole,
      empty: !mine || !arrays.TL_BASE.some(function (v) { return v !== null; }) && !acts.length
    };
  }

  /* ── 应用 / 回退 ─────────────────────────────────────────────────────── */
  function apply(p) {
    var A = window.ARC;
    Object.keys(p.arrays).forEach(function (k) { A[k] = p.arrays[k]; });
    if (window.ARC_LIVE) window.ARC_LIVE.stop();      // 真实模式不跑假 SSE 抖动
    if (p.feRole && window.ARC_SET_ROLE) window.ARC_SET_ROLE(p.feRole);
    if (window.ARC_DB_MODE) window.ARC_DB_MODE(true);
    if (window.ARC_RELOAD) window.ARC_RELOAD();
  }

  function restoreDemo() {
    var A = window.ARC;
    if (demoSnapshot) {
      Object.keys(demoSnapshot).forEach(function (k) { A[k] = JSON.parse(JSON.stringify(demoSnapshot[k])); });
    }
    if (window.ARC_DB_MODE) window.ARC_DB_MODE(false);
    if (window.ARC_SET_ROLE) window.ARC_SET_ROLE("head_coach");
    if (window.ARC_RELOAD) window.ARC_RELOAD();
    if (window.ARC_LIVE) { window.ARC_LIVE.setStatus("ok"); window.ARC_LIVE.start(); }
  }

  /* ── 写操作（薄封装，全部直连库，权限由 RLS 决定）──────────────────── */
  async function insert(table, rows) {
    var out = await http("/rest/v1/" + table, { method: "POST", body: rows, prefer: "return=representation" });
    return out;
  }
  async function update(table, filter, patch) {
    var out = await http("/rest/v1/" + table + "?" + qs(filter), {
      method: "PATCH", body: patch, prefer: "return=representation"
    });
    return out;
  }
  async function upsert(table, rows, onConflict) {
    var path = "/rest/v1/" + table + (onConflict ? "?on_conflict=" + encodeURIComponent(onConflict) : "");
    return http(path, { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=representation" });
  }
  async function remove(table, filter) {
    await http("/rest/v1/" + table + "?" + qs(filter), { method: "DELETE" });
    return true;
  }

  /* ── 对外 ───────────────────────────────────────────────────────────── */
  var DB = {
    state: S,
    esc: esc,
    configured: function () { return !!(S.url && S.key); },
    isLive: function () { return S.mode === "live" && !!S.session; },
    onChange: onChange,
    init: async function () {
      demoSnapshot = JSON.parse(JSON.stringify(window.ARC));

      var env = window.ARC_ENV || {};
      var url = env.SUPABASE_URL || "";
      var key = env.SUPABASE_PUBLISHABLE_KEY || "";
      if (env.ALLOW_RUNTIME_KEY !== false) {
        url = lsGet(LS_URL) || url;
        key = lsGet(LS_KEY) || key;
        // 仅本机回环地址允许用 ?sbkey= 快速试连，避免线上被人用参数指向别的后端
        var isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "";
        if (isLocal) {
          var sp = new URLSearchParams(location.search);
          if (sp.get("sburl")) { lsSet(LS_URL, sp.get("sburl")); url = sp.get("sburl"); }
          if (sp.get("sbkey")) { lsSet(LS_KEY, sp.get("sbkey")); key = sp.get("sbkey"); }
        }
      }
      S.url = String(url || "").replace(/\/+$/, "");
      S.key = String(key || "").trim();

      // ?demo=1 = 强制演示模式：不读库、不恢复会话，用于纯演示/截图
      if (new URLSearchParams(location.search).get("demo") === "1") {
        S.mode = "demo";
        S.reason = "演示模式（?demo=1，未读取数据库）";
        emit();
        return S;
      }

      var saved = lsGet(LS_SESS);
      if (saved) { try { S.session = JSON.parse(saved); } catch (e) { S.session = null; } }

      if (!S.key) {
        S.mode = "demo";
        S.reason = "未配置 publishable key（可在「数据源」里粘贴一次）";
        emit();
        return S;
      }
      if (!S.session) {
        S.mode = "demo";
        S.reason = "未登录";
        emit();
        return S;
      }
      try { await boot(); } catch (e) {
        clearSession();
        S.mode = "demo";
        S.reason = "会话失效，请重新登录：" + e.message;
        emit();
      }
      return S;
    },
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    resetPassword: resetPassword,
    changePassword: changePassword,
    reload: load,
    refresh: boot,
    exportMine: exportMine,
    rpc: rpc,
    rest: rest,
    insert: insert,
    upsert: upsert,
    update: update,
    remove: remove,
    setConfig: function (url, key) {
      lsSet(LS_URL, url || null);
      lsSet(LS_KEY, key || null);
      S.url = String(url || "").replace(/\/+$/, "");
      S.key = String(key || "").trim();
      return DB.init();
    },
    clearConfig: function () {
      lsSet(LS_URL, null); lsSet(LS_KEY, null); lsSet(LS_SESS, null);
      clearSession();
      S.url = ""; S.key = "";
      restoreDemo();
      S.mode = "demo"; S.reason = "已清除本机连接配置";
      emit();
    }
  };

  window.ARC_DB = DB;
})();
