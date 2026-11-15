/* 第三世界 · 真实流程界面（登录门 / 开通向导 / 记录训练 / 团队管理 / 数据源面板）
 *
 * 只做一件事：把 ARC_DB 的能力变成「人能点的东西」。
 * 所有写操作都调 RPC 或直写表，失败时把数据库给的原因翻译成人话摆在用户面前。
 */
(function () {
  "use strict";

  var DB = window.ARC_DB;
  var esc = DB.esc;

  var U = {
    view: null,        // gate | onboarding | panel | record
    tab: "signin",     // signin | signup
    rec: "training",   // training | checkin | jump | team
    scope: "train",    // train | test —— 训练与测试各自独立的记录入口
    segments: [{ type: "strength", dur: 45, rpe: 7 }],  // 当前自行搭配的训练段
    planName: "",
    err: "",
    msg: "",
    lastEmail: "",
    busy: false,
    lastInvite: null
  };

  /* ── 小工具 ─────────────────────────────────────────────────────────── */
  var SEX = { male: "男", female: "女", unspecified: "未填" };
  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value.trim() : ""; }
  function numOr(id, d) { var v = val(id); return v === "" ? d : Number(v); }
  function todayLocal() {
    var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  function ymdToday() {
    var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  /* ── 训练搭配方案（只作用于训练模块，不含任何测试项目） ────────────── */
  var LS_PLANS = "arc_training_plans_v1";
  function trainTypes() { return (window.ARC && window.ARC.TRAIN_TYPES) || []; }
  function trainPresets() { return (window.ARC && window.ARC.TRAIN_PRESETS) || []; }
  function typeLabel(id) {
    var t = trainTypes().filter(function (x) { return x.id === id; })[0];
    return t ? t.label : id;
  }
  function typeSelectHtml(i, sel) {
    return '<select id="sType' + i + '" data-seg="type" data-i="' + i + '">' +
      trainTypes().map(function (t) {
        return '<option value="' + esc(t.id) + '"' + (t.id === sel ? " selected" : "") + '>' + esc(t.label) + '</option>';
      }).join("") + '</select>';
  }
  function myPlans() {
    try { return JSON.parse(localStorage.getItem(LS_PLANS) || "[]") || []; } catch (e) { return []; }
  }
  function writeMyPlans(list) {
    try { localStorage.setItem(LS_PLANS, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function collectSegments() {
    if (U.rec !== "training" || !el("sType0")) return U.segments.slice();
    var out = [], i = 0;
    while (el("sType" + i)) {
      out.push({
        type: el("sType" + i).value || "other",
        dur: Number(val("sDur" + i) || 0),
        rpe: Number(val("sRpe" + i) || 0)
      });
      i++;
    }
    if (out.length) U.segments = out;
    return U.segments.slice();
  }
  function segSummary(segs) {
    var dur = 0, tl = 0, parts = [];
    segs.forEach(function (s) {
      var d = Number(s.dur) || 0, r = Number(s.rpe) || 0;
      dur += d; tl += r * d; parts.push(r + "×" + d);
    });
    return { dur: dur, tl: tl, parts: parts };
  }
  function planOptionsHtml() {
    var opts = ['<option value="">选择一套方案载入…</option>', '<optgroup label="预设结构方案">'];
    trainPresets().forEach(function (p) {
      opts.push('<option value="preset:' + esc(p.id) + '">' + esc(p.name) + " · " + esc(p.note) + '</option>');
    });
    opts.push('</optgroup>');
    var mine = myPlans();
    if (mine.length) {
      opts.push('<optgroup label="我的方案">');
      mine.forEach(function (p) { opts.push('<option value="mine:' + esc(p.name) + '">' + esc(p.name) + "</option>"); });
      opts.push('</optgroup>');
    }
    return opts.join("");
  }
  function segRowsHtml() {
    return U.segments.map(function (s, i) {
      return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<span style="width:18px;flex:0 0 18px;color:var(--text-3);font-size:12px">' + (i + 1) + '</span>' +
        typeSelectHtml(i, s.type) +
        '<input id="sDur' + i + '" type="number" min="1" max="600" value="' + esc(s.dur) + '" title="分钟" style="width:66px;flex:0 0 66px">' +
        '<input id="sRpe' + i + '" type="number" min="0" max="10" step="0.5" value="' + esc(s.rpe) + '" title="RPE 0–10" style="width:66px;flex:0 0 66px">' +
        '<button data-u="seg-del" data-i="' + i + '" title="删除这一段" style="flex:0 0 28px;border:1px solid var(--separator);background:transparent;border-radius:8px">✕</button>' +
        '</div>';
    }).join("");
  }

  function toast(text, tone) {
    var host = el("arcToast");
    if (!host) {
      host = document.createElement("div");
      host.id = "arcToast";
      host.className = "arc-toast-host";
      document.body.appendChild(host);
    }
    var t = document.createElement("div");
    t.className = "arc-toast " + (tone || "ok");
    t.textContent = text;
    host.appendChild(t);
    setTimeout(function () { t.classList.add("out"); }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3100);
  }
  function errText(e) {
    var m = String((e && e.message) || e || "");
    // 认证类：这几条直接决定用户下一步做什么，必须说人话
    if (/invalid login credentials|invalid_credentials/i.test(m)) return "邮箱或密码不正确。";
    if (/email not confirmed/i.test(m)) return "邮箱还没确认：请点邮件里的确认链接；没收到就让管理员在后台确认账号。";
    // 这条是「整个登录方式被关掉」，不是密码错：不翻译的话用户会一直怀疑密码
    if (/email logins? (are )?disabled|email provider.*disabled/i.test(m)) {
      return "这个项目没有开启「邮箱登录」：Dashboard → Authentication → Sign In / Providers → Email → 打开 Enable Email provider，刷新后重试（docs/10 第 3 项）。";
    }
    if (/phone logins? (are )?disabled/i.test(m)) return "项目没开手机号登录：需要先配短信服务商、签名与模板（docs/10 第 6 项）。";
    if (/user not found/i.test(m)) return "这个邮箱还没有注册。";
    if (/invalid api key|no apikey|apikey.*invalid/i.test(m)) return "publishable key 无效：检查是否完整复制（在「数据源」里重填）。";
    if (/rate limit|too many requests/i.test(m)) return "请求太频繁，请稍等一会儿再试。";
    if (/signups? not allowed|signup.*disabled/i.test(m)) return "项目未开放注册：请在后台打开 Email 注册，或由管理员建号。";
    if (/password.*(least|short)|weak.?password/i.test(m)) return "密码太短，至少 8 位。";
    // 数据与权限类
    if (/row-level security|42501/.test(m)) return "当前角色没有这个权限（数据库已拒绝写入）。";
    if (/23505|duplicate key/.test(m)) return "这条记录已存在，不要重复提交。";
    if (/23503|foreign key/.test(m)) return "关联对象不存在（可能已被删除）。";
    if (/23514|check constraint/.test(m)) return "数值超出允许范围，请检查后重试。";
    if (/network|Failed to fetch|网络不可达|load failed/i.test(m)) return "请求没到服务器：可能是网络不通，或浏览器拦了跨域请求（检查 Project URL 与 CORS）。";
    if (/JWT|401/.test(m)) return "登录已失效，请重新登录。";
    return m.replace(/^.*?·\s*/, "").slice(0, 180);
  }

  /* ── 状态机：该显示什么 ─────────────────────────────────────────────── */
  function needGate() {
    if (!DB.configured()) return false;               // 没配 key：保持原型可演示
    if (new URLSearchParams(location.search).get("demo") === "1") return false;
    if (!DB.state.session) return true;
    return false;
  }
  var lastKey = null;
  function sync() {
    var s = DB.state;
    if (needGate()) { U.view = "gate"; }
    else if (s.session && s.needOnboarding) { U.view = "onboarding"; }
    else if (U.view === "gate" || U.view === "onboarding") { U.view = null; }
    render();
    // 数据源徽标由 app.js 的 renderConsole 生成，而 app.js 首次渲染时本文件还没加载。
    // 连接状态一变就重渲染一次外壳，保证徽标/角色锁/顶栏入口和真实状态一致。
    var key = s.mode + "|" + (s.session ? "1" : "0") + "|" + (s.me ? s.me.email : "") + "|" + (s.role || "");
    if (key !== lastKey) {
      lastKey = key;
      if (window.ARC_RELOAD) window.ARC_RELOAD();
    }
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */
  function render() {
    var host = el("arcUI");
    if (!host) {
      host = document.createElement("div");
      host.id = "arcUI";
      document.body.appendChild(host);
    }
    if (!U.view) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    if (U.view === "gate") host.innerHTML = gateHtml();
    else if (U.view === "onboarding") host.innerHTML = onboardHtml();
    else if (U.view === "panel") host.innerHTML = panelHtml();
    else if (U.view === "record") host.innerHTML = recordHtml();
    if (U.view === "record" && U.rec === "training") previewTraining();
    if (U.view === "record" && U.rec === "jump") previewJump();
  }

  function shell(inner, wide) {
    return '<div class="arcui-mask" data-u="mask"><div class="arcui-card' + (wide ? " wide" : "") + '" role="dialog" aria-modal="true">' +
      inner + '</div></div>';
  }

  function gateHtml() {
    var isSignup = U.tab === "signup";
    var s = DB.state || {};
    var host = "";
    try { host = s.url ? new URL(s.url).host : ""; } catch (e) { host = s.url || ""; }
    // 登录前就把「要连哪个库」说出来：地址被本机覆盖成 mock 时，这里会立刻暴露，
    // 而不是等登录成功后看到一堆熟悉但其实是假的数据。
    var target =
      '<div class="arcui-hint" style="display:flex;gap:8px;align-items:center;justify-content:space-between">' +
      '<span>' + (host ? "连接目标 · <b>" + esc(host) + "</b>" : "未配置后端地址") + '</span>' +
      (s.override
        ? '<button data-u="clear-override" style="color:#a06000;text-decoration:underline">清除本机覆盖</button>'
        : "") +
      '</div>';
    var noKey = !s.key
      ? '<div class="arcui-err">没有 publishable key，登录无法进行。在 prototype/env.js 填 SUPABASE_PUBLISHABLE_KEY 后刷新（见 docs/10）。</div>'
      : "";
    return shell(
      '<div class="arcui-brand"><div class="arcui-mark">第</div><div>' +
      '<div class="arcui-title">第三世界</div>' +
      '<div class="arcui-sub">训练负荷 · 恢复 · 力量速度</div></div></div>' +
      target + noKey +
      '<div class="arcui-tabs">' +
      '<button class="' + (!isSignup ? "on" : "") + '" data-u="tab" data-v="signin">登录</button>' +
      '<button class="' + (isSignup ? "on" : "") + '" data-u="tab" data-v="signup">注册</button></div>' +
      (isSignup
        ? '<label class="arcui-field"><span>称呼</span><input id="fName" autocomplete="name" placeholder="例如：林澈" maxlength="20"></label>'
        : "") +
      '<label class="arcui-field"><span>邮箱</span><input id="fEmail" type="email" autocomplete="email" placeholder="you@example.com" inputmode="email" value="' + esc(U.lastEmail || "") + '"></label>' +
      '<label class="arcui-field"><span>密码</span><input id="fPwd" type="password" autocomplete="' + (isSignup ? "new-password" : "current-password") + '" placeholder="至少 8 位"></label>' +
      (isSignup ? '<div class="arcui-hint">密码至少 8 位；手机号登录与微信登录需要额外配置，见交付说明。</div>' : "") +
      (U.err ? '<div class="arcui-err">' + esc(U.err) + '</div>' : "") +
      (U.msg ? '<div class="arcui-ok">' + esc(U.msg) + '</div>' : "") +
      '<button class="arcui-primary" data-u="submit-auth" ' + (U.busy ? "disabled" : "") + '>' +
      (U.busy ? "处理中…" : (isSignup ? "创建账号" : "登录")) + '</button>' +
      '<div class="arcui-links">' +
      (isSignup ? "" : '<button data-u="forgot">忘记密码</button>') +
      (isSignup ? "" : '<button data-u="resend">没收到确认邮件？重发</button>') +
      '</div>' +
      '<div class="arcui-foot">登录即表示同意《服务条款》与《隐私政策》。健康数据属敏感个人信息，仅用于训练分析，可随时导出或删除。</div>',
      false
    );
  }

  function onboardHtml() {
    var s = DB.state;
    return shell(
      '<div class="arcui-brand"><div class="arcui-mark">第</div><div>' +
      '<div class="arcui-title">先选一下你的身份</div>' +
      '<div class="arcui-sub">' + esc(s.me && s.me.email ? s.me.email : "") + ' · 只需设置一次</div></div></div>' +
      (U.err ? '<div class="arcui-err">' + esc(U.err) + '</div>' : "") +
      '<div class="arcui-choice">' +
      '<button data-u="mode" data-v="solo"><b>我是运动员</b><span>创建个人空间，记录自己的训练与恢复</span></button>' +
      '<button data-u="mode" data-v="org"><b>我是教练 / 机构</b><span>建立团队，邀请队员加入并查看团队数据</span></button>' +
      '<button data-u="mode" data-v="invite"><b>我有邀请码</b><span>加入已有团队（向教练索取 8 位邀请码）</span></button>' +
      '</div>' +
      '<div id="onboardForm"></div>' +
      '<div class="arcui-links"><button data-u="signout">退出登录</button></div>',
      false
    );
  }

  function onboardFormHtml(mode) {
    if (mode === "solo") {
      return '<label class="arcui-field"><span>显示名</span><input id="fDisplay" value="' + esc((DB.state.me && DB.state.me.display_name) || "") + '" placeholder="队友看到的名字" maxlength="20"></label>' +
        '<button class="arcui-primary" data-u="do-solo" ' + (U.busy ? "disabled" : "") + '>创建个人空间</button>';
    }
    if (mode === "org") {
      return '<label class="arcui-field"><span>组织 / 队伍名称</span><input id="fOrg" placeholder="例如：星河田径队" maxlength="60"></label>' +
        '<label class="arcui-field"><span>你的称呼</span><input id="fDisplay2" value="' + esc((DB.state.me && DB.state.me.display_name) || "") + '" maxlength="20"></label>' +
        '<label class="arcui-check"><input type="checkbox" id="fAlso" checked><span>我也要记录自己的训练（同时建一份运动员档案）</span></label>' +
        '<button class="arcui-primary" data-u="do-org" ' + (U.busy ? "disabled" : "") + '>创建组织</button>';
    }
    return '<label class="arcui-field"><span>邀请码</span><input id="fCode" placeholder="8 位字母数字" maxlength="16" style="letter-spacing:.18em;text-transform:uppercase"></label>' +
      '<button class="arcui-primary" data-u="do-invite" ' + (U.busy ? "disabled" : "") + '>加入团队</button>';
  }

  function recordHtml() {
    var s = DB.state;
    var isTest = U.scope === "test";
    // 训练与测试各有独立入口，同一个浮层里不再把 CMJ 和训练段摆在一起。
    var tabs = isTest ? [["jump", "跳跃测试"]] : [["training", "训练"], ["checkin", "每日自评"]];
    if (!isTest && (s.role === "org_admin" || s.role === "team_admin" || s.role === "coach" || s.role === "clinician")) {
      tabs.push(["team", "团队"]);
    }
    var note = isTest
      ? "测试记录写入测试模块，<b>不参与 TL 与 ACWR</b>。"
      : "训练记录只产生 <b>TL</b>；<b>ACWR</b> 由服务端按日负荷重算。";
    var swap = isTest
      ? '<button data-u="scope" data-v="train" style="flex:0 0 auto;color:var(--accent);text-decoration:underline">去记录训练</button>'
      : '<button data-u="scope" data-v="test" style="flex:0 0 auto;color:var(--accent);text-decoration:underline">去记录测试</button>';
    return shell(
      '<div class="arcui-head"><b>' + (isTest ? "记录测试" : "记录训练") + '</b><button class="arcui-x" data-u="close">✕</button></div>' +
      '<div class="arcui-hint" style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span>' + note + '</span>' + swap + '</div>' +
      '<div class="arcui-tabs small">' + tabs.map(function (t) {
        return '<button class="' + (U.rec === t[0] ? "on" : "") + '" data-u="rectab" data-v="' + t[0] + '">' + t[1] + '</button>';
      }).join("") + '</div>' +
      '<div id="recBody">' + recBodyHtml() + '</div>' +
      (U.err ? '<div class="arcui-err">' + esc(U.err) + '</div>' : "") +
      (U.msg ? '<div class="arcui-ok">' + esc(U.msg) + '</div>' : ""),
      true
    );
  }

  function recBodyHtml() {
    var s = DB.state;
    var ath = s.primaryAthlete;
    if (!ath) {
      return '<div class="arcui-empty">当前账号没有运动员档案。' +
        (s.role === "org_admin" || s.role === "coach"
          ? '去「团队」页添加队员，或重新开通时勾选「我也要记录自己的训练」。'
          : '请联系教练补建档案。') + '</div>';
    }
    if (U.rec === "training") {
      return '<label class="arcui-field"><span>时间</span><input id="tWhen" type="datetime-local" value="' + todayLocal() + '"></label>' +
        '<div class="arcui-sub2">训练段 · 类型 / 分钟 / RPE（可增删，顺序即执行顺序）</div>' +
        '<div id="segList">' + segRowsHtml() + '</div>' +
        '<div class="arcui-actions"><button data-u="seg-add">＋ 添加一段</button><button data-u="seg-clear">清空</button></div>' +
        '<div class="arcui-sub2">搭配方案</div>' +
        '<div class="arcui-row">' +
        '<label class="arcui-field"><span>载入方案</span><select id="planSel">' + planOptionsHtml() + '</select></label>' +
        '<label class="arcui-field"><span>方案名称</span><input id="planName" maxlength="24" placeholder="例如：周三力量课" value="' + esc(U.planName || "") + '"></label>' +
        '</div>' +
        '<div class="arcui-actions"><button data-u="seg-load">载入</button>' +
        '<button data-u="seg-save">保存为我的方案</button>' +
        '<button data-u="seg-delete">删除我的方案</button></div>' +
        '<div class="arcui-row">' +
        '<label class="arcui-field"><span>距离（km，可选）</span><input id="tDist" type="number" min="0" step="0.01" placeholder="—" inputmode="decimal"></label>' +
        '</div>' +
        '<div class="arcui-calc" id="tPreview"></div>' +
        '<div class="arcui-hint">每段 TL = 该段 RPE × 该段分钟；本次 TL = 各段之和。训练模块只输出 <b>TL</b> 与 <b>ACWR</b>。</div>' +
        '<button class="arcui-primary" data-u="save-training" ' + (U.busy ? "disabled" : "") + '>保存训练</button>' +
        '<div class="arcui-note">方案只是结构模板，不代表已发生的训练；保存后写入一条真实记录，分段明细存在该记录的 raw 字段里。测试项目请到「记录测试」。</div>';
    }
    if (U.rec === "checkin") {
      return '<label class="arcui-field"><span>日期</span><input id="cDate" type="date" value="' + ymdToday() + '"></label>' +
        '<div class="arcui-row">' +
        '<label class="arcui-field"><span>睡眠时长（小时）</span><input id="cSleep" type="number" min="0" max="16" step="0.1" placeholder="7.5" inputmode="decimal"></label>' +
        '<label class="arcui-field"><span>HRV RMSSD（ms，可选）</span><input id="cHrv" type="number" min="1" max="300" step="1" placeholder="—" inputmode="numeric"></label>' +
        '</div>' +
        '<div class="arcui-hint">只写你确实测过的值；没测就留空，系统按「缺测」处理，不估算。</div>' +
        '<button class="arcui-primary" data-u="save-checkin" ' + (U.busy ? "disabled" : "") + '>保存</button>';
    }
    if (U.rec === "jump") {
      return '<div class="arcui-row">' +
        '<label class="arcui-field"><span>类型</span><select id="jType">' +
        [["cmj", "CMJ"], ["sj", "SJ"], ["dj", "DJ 跳深"], ["rj", "RSI 10-5（连续跳）"]]
          .map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join("") +
        '</select></label>' +
        '<label class="arcui-field"><span>视频帧率（fps，可选）</span><input id="jFps" type="number" min="30" max="2000" placeholder="240" inputmode="numeric"></label>' +
        '</div>' +
        '<div class="arcui-row">' +
        '<label class="arcui-field"><span>腾空时间（ms）</span><input id="jFly" type="number" min="50" max="3000" step="1" placeholder="512" inputmode="numeric"></label>' +
        '<label class="arcui-field"><span>触地时间（ms，DJ 必填）</span><input id="jCon" type="number" min="0" max="3000" step="1" placeholder="—" inputmode="numeric"></label>' +
        '</div>' +
        '<div class="arcui-calc" id="jPreview"></div>' +
        '<div class="arcui-hint">高度按 h = g·t²/8 计算；RSI 需要触地时间，缺了就不给值（不猜）。</div>' +
        '<button class="arcui-primary" data-u="save-jump" ' + (U.busy ? "disabled" : "") + '>保存测试</button>';
    }
    // 团队
    return '<div class="arcui-sub2">成员（' + (DB.state.athletes || []).length + '）</div>' +
      ((DB.state.athletes || []).length
        ? '<div class="arcui-list">' + DB.state.athletes.map(function (a) {
            return '<div class="arcui-li"><b>' + esc(a.full_name) + '</b><span>' + esc(SEX[a.sex] || "") +
              (a.teams && a.teams.name ? " · " + esc(a.teams.name) : "") + '</span></div>';
          }).join("") + '</div>'
        : '<div class="arcui-empty">还没有成员。可以添加，也可以生成邀请码让队员自己加入。</div>') +
      '<div class="arcui-sub2">邀请码</div>' +
      (U.lastInvite
        ? '<div class="arcui-code">' + esc(U.lastInvite.code) + '<button data-u="copy-code">复制</button></div>' +
          '<div class="arcui-hint">' + esc(U.lastInvite.note) + '</div>'
        : '<div class="arcui-row"><label class="arcui-field"><span>角色</span><select id="iRole">' +
            [["athlete", "运动员"], ["coach", "教练"], ["analyst", "科研 / 数据"], ["clinician", "队医 / 康复"], ["observer", "只读观察者"]]
              .map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join("") +
          '</select></label><label class="arcui-field"><span>可用次数</span><input id="iUses" type="number" min="1" max="500" value="10" inputmode="numeric"></label></div>' +
          '<button class="arcui-primary" data-u="gen-invite" ' + (U.busy ? "disabled" : "") + '>生成邀请码</button>') +
      '<div class="arcui-sub2">新增成员（无账号也可先建档案）</div>' +
      '<div class="arcui-row"><label class="arcui-field"><span>姓名</span><input id="nName" maxlength="40" placeholder="例如：周珩"></label>' +
      '<label class="arcui-field"><span>性别</span><select id="nSex"><option value="">未填</option><option value="male">男</option><option value="female">女</option></select></label></div>' +
      '<button class="arcui-primary ghost" data-u="add-member" ' + (U.busy ? "disabled" : "") + '>添加成员</button>';
  }

  function panelHtml() {
    var s = DB.state;
    var badge = s.mode === "live" ? '<span class="arcui-badge live">真实库</span>' : '<span class="arcui-badge demo">未连接</span>';
    return shell(
      '<div class="arcui-head"><b>数据源与账号</b><button class="arcui-x" data-u="close">✕</button></div>' +
      '<div class="arcui-status">' + badge + '<span>' + esc(s.reason) + '</span></div>' +
      (s.session
        ? '<dl class="arcui-kv">' +
          '<dt>账号</dt><dd>' + esc(s.me && s.me.email) + '</dd>' +
          '<dt>组织</dt><dd>' + esc(s.orgName || (s.orgId ? String(s.orgId).slice(0, 8) : "—")) + '</dd>' +
          '<dt>角色</dt><dd>' + esc(s.role || "—") + (s.feRole ? ' → 界面 ' + esc(s.feRole) : "") + '</dd>' +
          '<dt>运动员档案</dt><dd>' + (s.primaryAthlete ? esc(s.primaryAthlete.full_name) : "无") + '</dd>' +
          '<dt>最后同步</dt><dd>' + esc(s.lastSync || "—") + '</dd>' +
          '<dt>数据量</dt><dd>训练 ' + ((window.ARC.SESSIONS || []).length) + ' 条 · 成员 ' + ((window.ARC.ATHLETES || []).length) + ' 人</dd>' +
          '</dl>' +
          '<div class="arcui-actions"><button data-u="reload">重新同步</button><button data-u="export">导出我的数据</button><button data-u="signout">退出登录</button></div>' +
          '<div class="arcui-sub2">账号安全</div>' +
          '<label class="arcui-field"><span>修改密码（至少 8 位）</span>' +
          '<input id="cNewPwd" type="password" autocomplete="new-password" maxlength="72" placeholder="留空表示不改"></label>' +
          '<div class="arcui-row"><button class="arcui-primary ghost" data-u="change-pwd" ' + (U.busy ? "disabled" : "") + '>保存新密码</button></div>'
        : '') +
      (U.err ? '<div class="arcui-err">' + esc(U.err) + '</div>' : "") +
      (U.msg ? '<div class="arcui-ok">' + esc(U.msg) + '</div>' : "") +
      '<div class="arcui-sub2">连接配置</div>' +
      '<label class="arcui-field"><span>Project URL</span><input id="cUrl" value="' + esc(s.url) + '" placeholder="https://xxx.supabase.co"></label>' +
      '<label class="arcui-field"><span>Publishable key</span><input id="cKey" value="' + esc(s.key) + '" placeholder="sb_publishable_…"></label>' +
      '<div class="arcui-hint">publishable key 可以公开放在前端；真正的权限在数据库行级安全（RLS）。service_role key 不要填这里。</div>' +
      '<div class="arcui-actions"><button data-u="save-conn">保存并重连</button><button data-u="clear-conn">清除本机配置</button></div>' +
      (s.queries.length
        ? '<div class="arcui-sub2">读取诊断</div><table class="arcui-tbl"><thead><tr><th>数据集</th><th>行</th><th>耗时</th><th>结果</th></tr></thead><tbody>' +
          s.queries.map(function (q) {
            return '<tr><td>' + esc(q.name) + '</td><td>' + q.rows + '</td><td>' + q.ms + 'ms</td><td>' +
              (q.ok ? "✓" : '<span class="bad">' + esc(q.error || "失败") + '</span>') + '</td></tr>';
          }).join("") + '</tbody></table>' +
          (s.regMismatch ? '<div class="arcui-warn">有 ' + s.regMismatch + ' 个指标的公式文本与库内 metric_registry 不一致（已在交付报告里列出）。</div>' : '')
        : '') +
      '<div class="arcui-note">数据源尚未连接，页面暂不显示业务数值。</div>',
      true
    );
  }

  /* ── 交互 ───────────────────────────────────────────────────────────── */
  function bindOnce() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-u]") : null;
      if (!t) return;
      var u = t.getAttribute("data-u");
      if (u === "mask") { if (t === e.target && U.view !== "gate" && U.view !== "onboarding") close(); return; }
      handle(u, t);
    });
    document.addEventListener("input", function (e) {
      var id = e.target.id || "";
      if (/^sDur\d+$/.test(id) || /^sRpe\d+$/.test(id)) previewTraining();
      if (id === "jFly" || id === "jCon") previewJump();
    });
    document.addEventListener("change", function (e) {
      if (e.target.dataset && e.target.dataset.seg === "type") collectSegments();
      var id = e.target.id || "";
      if (/^sDur\d+$/.test(id) || /^sRpe\d+$/.test(id)) previewTraining();
    });
  }

  function previewTraining() {
    var box = el("tPreview"); if (!box) return;
    var segs = collectSegments(), m = segSummary(segs);
    if (!segs.length || m.dur <= 0) { box.textContent = "TL 预览：—（先添加至少一段训练）"; return; }
    box.textContent = segs.length + " 段 · 共 " + m.dur + " min · TL = " + m.parts.join(" + ") +
      " = " + Math.round(m.tl) + " AU；保存后由服务端重算 ACWR。";
  }
  function previewJump() {
    var box = el("jPreview"); if (!box) return;
    var fly = Number(val("jFly") || 0), con = Number(val("jCon") || 0);
    if (!fly) { box.textContent = "预测：—"; return; }
    var tf = fly / 1000;
    var h = 9.81 * tf * tf / 8 * 100;
    var s = "跳跃高度 ≈ " + h.toFixed(1) + " cm";
    if (con > 0) s += " · RSI ≈ " + (h / 100 / (con / 1000)).toFixed(2) + " m/s";
    else s += " · RSI 需要触地时间，未填则不给值";
    box.textContent = s;
  }

  async function handle(u, t) {
    var s = DB.state;
    try {
      if (u === "tab") { U.tab = t.getAttribute("data-v"); U.err = ""; U.msg = ""; render(); return; }
      if (u === "demo") { close(); return; }
      if (u === "close") { close(); return; }
      if (u === "forgot") {
        var email = val("fEmail");
        if (!email) { U.err = "先填邮箱，再点忘记密码"; render(); return; }
        U.busy = true; render();
        await DB.resetPassword(email);
        U.busy = false;
        U.msg = "重置邮件已发送（若项目未配置邮件服务，这一步不会有邮件，见交付说明）";
        U.err = "";
        render();
        return;
      }
      if (u === "submit-auth") {
        U.err = ""; U.msg = "";
        var mail = val("fEmail"), pwd = val("fPwd"), nm = val("fName");
        U.lastEmail = mail;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { U.err = "邮箱格式不对"; render(); return; }
        if (pwd.length < 8) { U.err = "密码至少 8 位"; render(); return; }
        U.busy = true; render();
        if (U.tab === "signup") {
          var r = await DB.signUp(mail, pwd, nm);
          U.busy = false;
          if (r.needConfirm) {
            U.tab = "signin";
            U.msg = "注册成功，确认邮件已发到 " + mail + "。点邮件里的链接会自动回到这里并登录；若几分钟没收到，点下方「没收到确认邮件？重发」。";
            if (r.redirectRejected) {
              U.msg += " 注意：本站的回跳地址还没在后台登记，邮件可能把你带到旧页面；遇到这种情况直接回来用邮箱密码登录即可。";
            }
            U.err = "";
          } else {
            sync();
            toast("账号已创建");
          }
        } else {
          await DB.signIn(mail, pwd);
          U.busy = false;
          sync();
          toast("已登录");
        }
        render();
        return;
      }
      if (u === "resend") {
        var rmail = val("fEmail") || U.lastEmail;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rmail)) {
          U.err = "先在邮箱框里填你要确认的邮箱"; U.msg = ""; render(); return;
        }
        U.lastEmail = rmail;
        U.busy = true; U.err = ""; U.msg = ""; render();
        try {
          await DB.resendConfirmation(rmail);
          U.msg = "确认邮件已重新发送到 " + rmail + "。点开链接后会自动回到这里并登录。";
        } catch (e) {
          U.err = "重发失败：" + (e && e.message ? e.message : String(e));
        }
        U.busy = false; render(); return;
      }
      if (u === "clear-override") {
        // 在登录浮层里也能清：否则「连错库」的人被困在登录框里，点不到被遮住的标签
        await DB.clearConfig();
        location.reload();
        return;
      }
      if (u === "signout") { await DB.signOut(); U.view = null; U.err = ""; U.msg = ""; render(); return; }
      if (u === "mode") {
        var mode = t.getAttribute("data-v");
        el("onboardForm").innerHTML = onboardFormHtml(mode);
        U.err = "";
        return;
      }
      if (u === "do-solo" || u === "do-org" || u === "do-invite") {
        U.err = ""; U.busy = true; render();
        if (u === "do-solo") {
          await DB.rpc("arc_join_solo", { p_display_name: val("fDisplay") || null });
        } else if (u === "do-org") {
          var orgName = val("fOrg");
          if (orgName.length < 2) throw new Error("组织名称至少 2 个字");
          await DB.rpc("arc_bootstrap_org", {
            p_org_name: orgName,
            p_display_name: val("fDisplay2") || null,
            p_also_athlete: !!(el("fAlso") && el("fAlso").checked)
          });
        } else {
          var code = val("fCode").toUpperCase();
          if (!code) throw new Error("请输入邀请码");
          await DB.rpc("arc_redeem_invite", { p_code: code });
        }
        U.busy = false;
        U.view = null;
        await DB.refresh();
        sync();
        toast("开通完成");
        return;
      }
      if (u === "reload") { close(); await DB.reload(); toast("已重新同步"); return; }
      if (u === "change-pwd") {
        var np = val("cNewPwd");
        if (!np) { U.err = "请输入新密码"; render(); return; }
        U.busy = true; render();
        await DB.changePassword(np);
        U.busy = false; U.err = ""; U.msg = "密码已更新，下次登录用新密码。";
        render();
        toast("密码已更新");
        return;
      }
      if (u === "export") {
        U.busy = true; render();
        await DB.exportMine();
        U.busy = false;
        toast("已导出 JSON（仅包含你有权读取的数据）");
        render();
        return;
      }
      if (u === "save-conn") {
        await DB.setConfig(val("cUrl"), val("cKey"));
        U.err = ""; sync();
        toast(DB.configured() ? "已保存连接配置" : "已保存，但 key 为空");
        return;
      }
      if (u === "clear-conn") { DB.clearConfig(); U.view = null; render(); toast("已清除"); return; }
      if (u === "rectab") { U.rec = t.getAttribute("data-v"); U.err = ""; U.msg = ""; render(); return; }

      if (u === "scope") {
        collectSegments();
        U.scope = t.getAttribute("data-v") === "test" ? "test" : "train";
        U.rec = U.scope === "test" ? "jump" : "training";
        U.err = ""; U.msg = ""; render();
        setTimeout(function () { U.scope === "test" ? previewJump() : previewTraining(); }, 0);
        return;
      }
      if (u === "seg-add") {
        var sa = collectSegments();
        if (sa.length >= 8) throw new Error("一次训练最多 8 段");
        sa.push({ type: "recovery", dur: 10, rpe: 3 });
        U.segments = sa; render(); setTimeout(previewTraining, 0); return;
      }
      if (u === "seg-del") {
        var sb = collectSegments(), si = Number(t.getAttribute("data-i"));
        if (sb.length <= 1) throw new Error("至少保留一段训练");
        sb.splice(si, 1); U.segments = sb; render(); setTimeout(previewTraining, 0); return;
      }
      if (u === "seg-clear") {
        U.segments = [{ type: "strength", dur: 45, rpe: 7 }];
        U.planName = ""; render(); setTimeout(previewTraining, 0); return;
      }
      if (u === "seg-load") {
        var pv = val("planSel"), loaded = false;
        if (!pv) throw new Error("先选择一套方案");
        if (pv.indexOf("preset:") === 0) {
          var pp = trainPresets().filter(function (x) { return x.id === pv.slice(7); })[0];
          if (pp) {
            U.segments = pp.seg.map(function (x) { return { type: x[0], dur: x[1], rpe: x[2] }; });
            U.planName = pp.name; loaded = true;
          }
        } else {
          var mp = myPlans().filter(function (x) { return x.name === pv.slice(5); })[0];
          if (mp) {
            U.segments = mp.seg.map(function (x) { return { type: x.type, dur: x.dur, rpe: x.rpe }; });
            U.planName = mp.name; loaded = true;
          }
        }
        if (!loaded) throw new Error("方案不存在或已被删除");
        U.msg = "已载入「" + U.planName + "」，可逐段修改后保存训练。"; U.err = "";
        render(); setTimeout(previewTraining, 0); return;
      }
      if (u === "seg-save") {
        collectSegments();
        var pn = val("planName");
        if (!pn) throw new Error("先填方案名称");
        var list = myPlans().filter(function (x) { return x.name !== pn; });
        list.push({ name: pn, seg: U.segments.map(function (x) { return { type: x.type, dur: x.dur, rpe: x.rpe }; }) });
        if (!writeMyPlans(list)) throw new Error("本机存储不可用，方案未保存");
        U.planName = pn; U.msg = "方案「" + pn + "」已保存到本机，下次可直接载入。"; U.err = "";
        render(); setTimeout(previewTraining, 0); return;
      }
      if (u === "seg-delete") {
        var dv = val("planSel");
        if (dv.indexOf("mine:") !== 0) throw new Error("请先在下拉里选中一个「我的方案」");
        var dn = dv.slice(5);
        writeMyPlans(myPlans().filter(function (x) { return x.name !== dn; }));
        U.msg = "已删除方案「" + dn + "」。"; U.err = "";
        render(); setTimeout(previewTraining, 0); return;
      }

      if (u === "save-training") {
        var ath = s.primaryAthlete;
        if (!ath) throw new Error("没有运动员档案");
        var when = val("tWhen");
        if (!when) throw new Error("请选择时间");
        var segs = collectSegments();
        if (!segs.length) throw new Error("至少添加一段训练");
        var bad = segs.filter(function (x) {
          return !(x.dur > 0) || x.dur > 600 || !(x.rpe >= 0) || x.rpe > 10;
        });
        if (bad.length) throw new Error("每段的时长需在 1–600 分钟、RPE 需在 0–10 之间");
        var m = segSummary(segs);
        if (m.dur > 600) throw new Error("单次训练总时长不能超过 600 分钟");
        var main = segs.slice().sort(function (a, b) { return b.dur - a.dur; })[0];
        var dist = val("tDist");
        U.busy = true; render();
        await DB.insert("activities", {
          org_id: ath.org_id,
          athlete_id: ath.id,
          started_at: new Date(when).toISOString(),
          sport: typeLabel(main.type),
          duration_s: Math.round(m.dur * 60),
          distance_m: dist === "" ? null : Math.round(Number(dist) * 1000),
          training_load: Math.round(m.tl),
          load_method: "srpe",
          rpe: Math.round(m.tl / m.dur),
          source: "manual",
          raw: { schema: "training.segments.v1", plan: U.planName || null, segments: segs }
        });
        U.busy = false;
        U.err = ""; U.msg = "已保存 " + segs.length + " 段训练 · 本次 TL " + Math.round(m.tl) + " AU。ACWR 由服务端重算。";
        await DB.reload();
        render();
        toast("训练已记录");
        return;
      }

      if (u === "save-checkin") {
        var ath2 = s.primaryAthlete;
        if (!ath2) throw new Error("没有运动员档案");
        var date = val("cDate"), sleepH = val("cSleep"), hrv = val("cHrv");
        if (!date) throw new Error("请选择日期");
        if (sleepH === "" && hrv === "") throw new Error("至少填一项");
        var rows = [];
        if (sleepH !== "") {
          var mins = Number(sleepH) * 60;
          if (!(mins >= 0) || mins > 960) throw new Error("睡眠时长需在 0–16 小时之间");
          rows.push({ org_id: ath2.org_id, athlete_id: ath2.id, metric_date: date, metric_id: "sleep.tst", value: Math.round(mins), unit: "min", quality: "ok", source: "manual", calc_version: "manual" });
        }
        if (hrv !== "") {
          var v = Number(hrv);
          if (!(v > 0) || v > 300) throw new Error("HRV 需在 1–300 ms 之间");
          rows.push({ org_id: ath2.org_id, athlete_id: ath2.id, metric_date: date, metric_id: "hrv.rmssd", value: v, unit: "ms", quality: "ok", source: "manual", calc_version: "manual" });
        }
        U.busy = true; render();
        await DB.upsert("daily_metrics", rows, "athlete_id,metric_date,metric_id");
        U.busy = false;
        U.err = ""; U.msg = "已保存。";
        await DB.reload(); render();
        toast("自评已保存");
        return;
      }

      if (u === "save-jump") {
        var ath3 = s.primaryAthlete;
        if (!ath3) throw new Error("没有运动员档案");
        var fly = Number(val("jFly")), con = val("jCon") === "" ? null : Number(val("jCon"));
        if (!(fly >= 50) || fly > 3000) throw new Error("腾空时间需在 50–3000 ms 之间");
        var tf = fly / 1000;
        var hcm = 9.81 * tf * tf / 8 * 100;
        var rsi = con ? (hcm / 100) / (con / 1000) : null;
        var fps = val("jFps") === "" ? null : Number(val("jFps"));
        U.busy = true; render();
        await DB.insert("test_sessions", {
          org_id: ath3.org_id,
          athlete_id: ath3.id,
          kind: "jump",
          performed_at: new Date().toISOString(),
          source: "manual",
          protocol: { method: "flight_time" },
          jump_tests: [{
            jump_type: val("jType"),
            height_cm: Math.round(hcm * 10) / 10,
            contact_ms: con,
            flight_ms: fly,
            rsi: rsi === null ? null : Math.round(rsi * 100) / 100,
            video_fps: fps,
            quality: "ok"
          }]
        });
        U.busy = false;
        U.err = ""; U.msg = "已保存：" + hcm.toFixed(1) + " cm" + (rsi ? " · RSI " + rsi.toFixed(2) : "");
        await DB.reload(); render();
        toast("测试已保存");
        return;
      }

      if (u === "gen-invite") {
        var r2 = await DB.rpc("arc_create_invite", {
          p_role: val("iRole"), p_team_id: null,
          p_max_uses: numOr("iUses", 10), p_days: 14
        });
        var row = Array.isArray(r2) ? r2[0] : r2;
        U.lastInvite = { code: row.code, note: "有效期 14 天，可用 " + row.max_uses + " 次。发给队员，让他们在注册后选「我有邀请码」。" };
        render();
        return;
      }
      if (u === "copy-code") {
        var c = U.lastInvite && U.lastInvite.code;
        if (c && navigator.clipboard) { try { await navigator.clipboard.writeText(c); toast("已复制 " + c); } catch (e) { toast("复制失败，请手动选中"); } }
        return;
      }
      if (u === "add-member") {
        var name = val("nName");
        if (!name) { U.err = "请填姓名"; render(); return; }
        U.busy = true; render();
        await DB.rpc("arc_add_athlete", { p_full_name: name, p_team_id: null, p_sex: val("nSex") || null, p_birth: null });
        U.busy = false;
        U.err = ""; U.msg = "已添加 " + name;
        await DB.reload(); render();
        toast("成员已添加");
        return;
      }
    } catch (e) {
      U.busy = false;
      U.err = errText(e);
      render();
    }
  }

  function close() { U.view = null; U.err = ""; U.msg = ""; render(); }

  function afterRender() {
    if (!DB.isLive()) return;
    // 空状态：真实库但还没有任何训练记录时，别让用户对着一堆「—」发呆
    var grid = document.querySelector("#content .page-grid");
    if (!grid || el("arcEmptyBanner")) return;
    var sessions = (window.ARC.SESSIONS || []).length;
    if (sessions > 0) return;
    var b = document.createElement("div");
    b.id = "arcEmptyBanner";
    b.className = "card span-3 arc-empty";
    b.innerHTML = '<b>还没有训练记录</b><span>记下第一次训练后，CTL / ATL / ACWR / TM / TS 会自动算出来。' +
      '空窗口不会显示 0，也不会估算。</span><button class="btn primary" data-act="arc-record">记录第一次训练</button>';
    grid.insertBefore(b, grid.firstChild);
  }

  window.ARC_UI = {
    pillHtml: function () {
      var s = DB.state;
      var live = s.mode === "live" && s.session;
      var label = live ? "已同步" : "未连接";
      var sub = live ? (s.me && s.me.email ? s.me.email.split("@")[0] : "") : "未连接";
      var tone = live ? "live" : "demo";
      // 同步中/失败/过期时外壳不能再说「演示数据 未连接」——内层页面此刻一个数字都没给，
      // 外壳却写成 DEMO，会让人以为自己在看演示。
      if (s.syncing) { label = "同步中"; sub = "暂不显示数值"; }
      else if (s.mode === "error" || s.error) { label = "数据未加载"; sub = "点此诊断"; }
      else if (s.stale) { label = "数据可能过期"; sub = s.lastSync || ""; }
      return '<button class="arc-pill ' + tone + '" data-act="db-panel" title="' +
        esc(s.reason) + '"><i></i>' + label + (sub ? '<span>' + esc(sub) + '</span>' : "") + '</button>';
    },
    openPanel: function () { U.view = "panel"; U.err = ""; U.msg = ""; render(); },
    openGate: function () { U.view = "gate"; U.tab = "signin"; U.err = ""; U.msg = ""; render(); },
    openRecord: function (scope) {
      if (!DB.isLive()) { U.view = "panel"; render(); toast("请先登录后再记录", "warn"); return; }
      U.scope = scope === "test" ? "test" : "train";
      U.rec = U.scope === "test" ? "jump" : "training";
      U.view = "record"; U.err = ""; U.msg = ""; U.lastInvite = null; render();
      setTimeout(function () { U.scope === "test" ? previewJump() : previewTraining(); }, 0);
    },
    afterRender: afterRender,
    toast: toast,
    close: close,
    _state: U
  };

  /* ── 启动 ───────────────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", function () {
    bindOnce();
    window.addEventListener("offline", function () { toast("网络已断开，界面保留最后一次同步的数据", "warn"); });
    window.addEventListener("online", function () { toast("网络已恢复"); if (DB.isLive()) DB.reload(); });
    DB.onChange(function () { if (U.view === "record" || U.view === "panel") render(); });
    DB.init().then(function () {
      // 邮件确认链接跳回来时，必须给一句明确的反馈。服务端其实已经确认成功，
      // 但过去应用不接管会话也不说话，用户看到的就是「点了没反应」。
      var cb = DB.state && DB.state.authCallback;
      if (cb) {
        if (cb.ok) { U.msg = cb.message; toast(cb.message); }
        else { U.err = cb.message; }
      }
      sync(); afterRender();
    });
  });
  DB.onChange(function () { sync(); });

  // app.js 重渲染后补空状态横幅
  var origReload = window.ARC_RELOAD;
  window.ARC_RELOAD = function () {
    if (origReload) origReload();
    setTimeout(afterRender, 0);
  };
})();
