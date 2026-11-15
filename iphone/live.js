/* ARC 训练 · 实时交互图表引擎 + 对标口径占位（DEMO）
 *
 * 重要边界：
 * - 本文件只做「原型级展示还原」：公开文档可查的评分名称、分档标签、状态含义，
 *   以及 DEMO 占位数值。不实现、不宣称还原任何厂商真实算法（EPOC / Firstbeat /
 *   自适应基线 / 传感器融合标定），不输出医学结论。
 * - 所有数值均为 DEMO 演示样例，不构成训练或医学建议。
 * - 数据来源与字段映射为「自研原型实现要点（对标能力域）」，不是任何厂商
 *   App 内部实现的还原；厂商云端 API 未取得授权前不假设可用。
 */
(function () {
  "use strict";
  const L = {};
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmmss = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const DEMO = '<span class="demo-mini">DEMO</span>';

  /* ── 1. 对标评分：公开可查口径 / 阈值分档 / 状态含义 ───────── */
  L.SCORES = [
    {
      id: "evlab.status", name: "EvoLab 训练状态 · Intensity Trend", vendor: "COROS", unit: "%",
      range: [0, 160], value: 112, status: "Optimized 优化区", categorical: false,
      definition: "Intensity Trend = Load Impact（7 日负荷）/ Base Fitness（42 日负荷），公开定义为长短期负荷之比。",
      meaning: "近期训练刺激处于厂商公开文档所称的「有效提升基础体能」区间。",
      basis: "A · COROS 官方帮助中心 / 官方故事页", refs: ["support.coros.com EvoLab", "coros.com Training Status"],
      bands: [
        { lo: 0, hi: 49, label: "Decreasing", zh: "下降", meaning: "近期负荷低，基础体能下降", tone: "mute" },
        { lo: 50, hi: 79, label: "Resuming / Performance", zh: "恢复 / 表现", meaning: "负荷回升或已减量，适合高强度表现；同区间两种状态由前一状态决定", tone: "info" },
        { lo: 80, hi: 99, label: "Maintaining", zh: "维持", meaning: "中等近期负荷，维持基础体能", tone: "ok" },
        { lo: 100, hi: 149, label: "Optimized", zh: "优化", meaning: "有效训练正在提升基础体能", tone: "ok" },
        { lo: 150, hi: 160, label: "Excessive", zh: "过量", meaning: "近期训练可能过度，公开文档建议降低负荷", tone: "warn" }
      ]
    },
    {
      id: "evlab.recovery", name: "EvoLab 恢复计时 · Recovery Timer", vendor: "COROS", unit: "%",
      range: [0, 100], value: 78, status: "可轻松训练", categorical: false,
      definition: "训练后给出「完全恢复」倒计时百分比，公开文档给出的上限为 96 小时 / 4 天。",
      meaning: "按公开帮助文档分档，处于「可轻松训练」区间。",
      basis: "A · COROS 官方帮助中心（与官方博客四档版本存在差异，见下方差异标注）", refs: ["support.coros.com EvoLab"],
      bands: [
        { lo: 0, hi: 29, label: "Rest", zh: "请休息", meaning: "公开帮助文档：请休息", tone: "warn" },
        { lo: 30, hi: 89, label: "Easy", zh: "可轻松训练", meaning: "公开帮助文档：可进行轻松训练", tone: "ok" },
        { lo: 90, hi: 100, label: "Hard", zh: "可高强度训练", meaning: "公开帮助文档：可进行高强度训练", tone: "info" }
      ],
      diff: "官方博客另给出四档：0–19 精疲力竭 / 20–69 疲劳 / 70–89 正常 / 90–100 充沛。原型采用官方帮助中心三档，差异在此标注，不合并、不选一为「唯一正确」。"
    },
    {
      id: "evlab.running", name: "EvoLab 跑步表现 · Running Performance", vendor: "COROS", unit: "%",
      range: [80, 120], value: 103, status: "Great 很好", categorical: false,
      definition: "最近一次路跑相对个人整体跑步体能的表现，公开区间 80%–120%，分 5 档。",
      meaning: "高于 100% 表示本次表现优于自身常态；公开文档提示需 >10 分钟且强度足够才产出。",
      basis: "A · COROS 官方帮助中心", refs: ["support.coros.com EvoLab"],
      bands: [
        { lo: 80, hi: 95, label: "Poor", zh: "较差", meaning: "低于 95% 公开文档提示可能需要更多休息", tone: "warn" },
        { lo: 96, hi: 98, label: "Fair", zh: "一般", meaning: "略低于自身常态", tone: "mute" },
        { lo: 99, hi: 101, label: "Good", zh: "良好", meaning: "接近自身常态", tone: "ok" },
        { lo: 102, hi: 104, label: "Great", zh: "很好", meaning: "优于自身常态", tone: "ok" },
        { lo: 105, hi: 120, label: "Excellent", zh: "优秀", meaning: "公开文档：可能处于竞技状态高峰", tone: "info" }
      ]
    },
    {
      id: "coros.hrv", name: "COROS 夜间 HRV 分类", vendor: "COROS", unit: "",
      range: [0, 4], value: null, status: "Normal 正常", categorical: true,
      definition: "睡眠期间 HRV 相对个人正常范围的四档分类（分类量，不是连续分数）。",
      meaning: "公开文档：在正常范围内，可按计划进行。",
      basis: "B · COROS 官方博客 / 恢复指标说明", refs: ["coros.com Recovery Metrics Explained"],
      bands: [
        { lo: 0, hi: 1, label: "Elevated", zh: "偏高", meaning: "高于个人正常范围，通常更放松，但需留意其他生理因素", tone: "info" },
        { lo: 1, hi: 2, label: "Normal", zh: "正常", meaning: "在正常范围内，按计划进行", tone: "ok" },
        { lo: 2, hi: 3, label: "Reduced", zh: "偏低", meaning: "略低于正常范围，身体可能处于压力，考虑额外休息", tone: "warn" },
        { lo: 3, hi: 4, label: "Low", zh: "很低", meaning: "显著低于正常范围，公开文档建议额外休息", tone: "warn" }
      ]
    },
    {
      id: "te.aerobic", name: "Training Effect · 有氧训练效果", vendor: "Garmin / Firstbeat", unit: "",
      range: [0, 5], value: 3.6, status: "Improves 提升", categorical: false,
      definition: "公开文档说明：以运动后过量氧耗（EPOC）映射到 0–5 刻度，并计入体能水平与训练习惯；有氧 / 无氧共用该刻度。",
      meaning: "3.0–3.9 公开表述为「改善有氧体能」。",
      basis: "A · Garmin 官方说明书 / 官方技术页", refs: ["garmin.com Training Effect", "www8.garmin.com About Training Effect"],
      bands: [
        { lo: 0, hi: 0.9, label: "No benefit", zh: "无收益", meaning: "无实质训练收益", tone: "mute" },
        { lo: 1, hi: 1.9, label: "Minor benefit", zh: "轻微收益", meaning: "轻微收益", tone: "mute" },
        { lo: 2, hi: 2.9, label: "Maintaining", zh: "维持", meaning: "维持当前有氧 / 无氧体能", tone: "ok" },
        { lo: 3, hi: 3.9, label: "Improving", zh: "提升", meaning: "改善有氧 / 无氧体能", tone: "ok" },
        { lo: 4, hi: 4.9, label: "Highly improving", zh: "显著提升", meaning: "显著改善有氧 / 无氧体能", tone: "info" },
        { lo: 5, hi: 5, label: "Overreaching", zh: "过度", meaning: "公开文档：恢复不足时可能过度、甚至有害", tone: "warn" }
      ]
    },
    {
      id: "bodybattery", name: "Body Battery 身体电量", vendor: "Garmin", unit: "",
      range: [5, 100], value: 68, status: "中等储备", categorical: false,
      definition: "公开说明书：综合 HRV、压力、睡眠与活动量估算可用储备能量；中文说明书区间 5–100。",
      meaning: "51–75 为「储备能量中等」。",
      basis: "A · Garmin 中文说明书 / 官方支持中心", refs: ["www8.garmin.com 说明书 Body Battery", "support.garmin.com FAQ"],
      bands: [
        { lo: 5, hi: 25, label: "极低", zh: "极低", meaning: "储备能量极低", tone: "warn" },
        { lo: 26, hi: 50, label: "低", zh: "低", meaning: "储备能量低", tone: "warn" },
        { lo: 51, hi: 75, label: "中等", zh: "中等", meaning: "储备能量中等", tone: "ok" },
        { lo: 76, hi: 100, label: "充足", zh: "充足", meaning: "储备能量充足", tone: "info" }
      ],
      diff: "英文支持页与部分说明书写作 0–100（0–25 低 / 26–50 中 / 51–75 高 / 76–100 很高），中文说明书为 5–100 且分档语义不同。原型采用中文说明书四档，差异在此标注，不合并为一套。"
    },
    {
      id: "hrv.status", name: "HRV Status 心率变异状态", vendor: "Garmin", unit: "",
      range: [0, 5], value: null, status: "平衡", categorical: true,
      definition: "公开说明书：睡眠期间心率读数得出 7 日平均 HRV 与个人基线 / 同龄范围比较后的分类状态；需约三周睡眠数据建立基线。",
      meaning: "7 日平均 HRV 在个人基线范围内。",
      basis: "A · Garmin 中文说明书「HRV 状态」", refs: ["www8.garmin.com HRV 状态"],
      bands: [
        { lo: 0, hi: 1, label: "平衡", zh: "平衡", meaning: "7 日平均 HRV 在基线范围内；公开文档称可能是训练恢复平衡、心血管健康与压力适应良好的积极迹象", tone: "ok" },
        { lo: 1, hi: 2, label: "不平衡", zh: "不平衡", meaning: "7 日平均高于或低于基线范围", tone: "warn" },
        { lo: 2, hi: 3, label: "低", zh: "低", meaning: "7 日平均远低于基线范围", tone: "warn" },
        { lo: 3, hi: 4, label: "差", zh: "差", meaning: "远低于同龄正常范围", tone: "warn" },
        { lo: 4, hi: 5, label: "无数据", zh: "无数据", meaning: "数据不足，无法生成 7 日平均值", tone: "mute" }
      ]
    },
    {
      id: "sleep.score", name: "Sleep Score 睡眠分数", vendor: "Garmin", unit: "",
      range: [0, 100], value: 84, status: "Good 良好", categorical: false,
      definition: "公开支持中心：对一夜睡眠给出 0–100 的评分；输入包含 HRV、呼吸、心率、身体移动、睡眠时长与分期。",
      meaning: "80–89 为「良好」。手动补录睡眠时长只提供时长，不生成睡眠分数。",
      basis: "A · Garmin 官方支持中心 Sleep Tracking", refs: ["support.garmin.com Sleep Tracking"],
      bands: [
        { lo: 0, hi: 59, label: "Poor", zh: "较差", meaning: "低于 60", tone: "warn" },
        { lo: 60, hi: 79, label: "Fair", zh: "一般", meaning: "60–79", tone: "mute" },
        { lo: 80, hi: 89, label: "Good", zh: "良好", meaning: "80–89", tone: "ok" },
        { lo: 90, hi: 100, label: "Excellent", zh: "优秀", meaning: "90–100", tone: "info" }
      ],
      diff: "官方博客另给出 100 / 99–80 / 79–50 / 49–0 的四档表述。原型采用官方支持中心四档，差异在此标注。"
    }
  ];
  L.SCORE_BY_ID = {}; L.SCORES.forEach(s => L.SCORE_BY_ID[s.id] = s);

  /* 占位分档判定：只在公开分档标签上做展示归位，不实现任何厂商算法 */
  function bandOf(s, v) {
    if (s.categorical || v === null) return s.bands.find(b => b.zh === s.status || b.label === s.status) || s.bands[0];
    for (const b of s.bands) if (v >= b.lo && v <= b.hi) return b;
    return s.bands[s.bands.length - 1];
  }
  L.bandOf = bandOf;

  /* ── 2. 数据融合：来源 / 字段映射 / 内部实现要点（自研原型） ── */
  L.FUSION = {
    sources: [
      ["心率带", "BLE GATT 0x180D / 0x2A37", "1 Hz", "device", "HR、RR 间期、传感器接触标志"],
      ["骑行台 / 功率计", "BLE CPS 0x1818 / 0x2A63 · FTMS Indoor Bike 0x2AD2", "4 Hz", "device", "瞬时功率、累积转数、踏频"],
      ["跑步机", "FTMS Treadmill 0x2ACD · RSC 0x1814 / 0x2A53", "1 Hz", "device", "速度、步频、坡度、距离"],
      ["运动手表", "FIT / TCX / GPX 文件；授权后厂商 API", "会话级", "import / api", "会话、HR、GPS、睡眠、HRV（若格式提供）"],
      ["VBT IMU", "CSV / JSON 导出；SDK 需授权", "200 Hz", "import", "三轴 acc + gyr、load_kg、exercise"],
      ["高帧率视频", "逐帧标记起跳 / 落地帧", "240 fps", "manual / import", "frame_takeoff、frame_landing、fps"],
      ["HealthKit / Health Connect", "用户授权读取", "日 / 夜", "api", "睡眠分期、HRV、静息心率"],
      ["手动录入表单", "App 内表单", "事件驱动", "manual", "会话 / 睡眠 / HRV / VBT 组 / 跳跃 / Wellness"],
      ["后台聚合任务", "worker → SSE", "5 min / 事件", "derived", "daily_load、hrv_reading、sleep_record"],
      ["厂商云端 API", "需开发者授权", "—", "api", "未申请前不假设可用"]
    ],
    mapping: [
      ["0x2A37 HR measurement", "raw_sample.value / stream_type=hr", "bpm", "hrv.rmssd / tl.trimp", "E1 / E9"],
      ["0x2A37 RR-interval", "raw_sample.value / stream_type=rr", "ms", "hrv.rmssd", "E1 / E9"],
      ["0x2A63 Cycling Power", "raw_sample.value / stream_type=power", "W", "tl.tss / NP / IF", "E1 / E7"],
      ["0x2AD2 Indoor Bike Data", "raw_sample.value / stream_type=power,cadence", "W / rpm", "tl.tss", "E2 / E7"],
      ["0x2ACD Treadmill Data", "raw_sample.value / stream_type=speed,cadence", "m/s / spm", "session", "E2"],
      ["0x2A53 RSC Measurement", "raw_sample.value / stream_type=speed,cadence", "m/s / spm", "session", "E1"],
      ["IMU ax / ay / az", "raw_sample.value / stream_type=acc_x/acc_y/acc_z", "m/s²", "vbt.mcv / mpv / pv", "E11"],
      ["IMU gx / gy / gz", "raw_sample.value / stream_type=gyr_x/gyr_y/gyr_z", "rad/s", "姿态对齐 / 切分", "E11"],
      ["IMU ts_ms", "raw_sample.ts_ms", "ms (UTC)", "时间对齐 / 重采样", "内部约定"],
      ["FIT session / record", "session.* / raw_sample.*", "多单位", "daily_load", "E3"],
      ["video frame_takeoff / landing", "jump_test.frame_* + fps", "frame / fps", "jump.height", "E13"],
      ["manual mpv_or_mcv", "strength_set.mpv / mcv / source=manual", "m/s", "vbt.vl / vbt.lvp", "E11"],
      ["manual flight_time_s", "jump_test.flight_time_s / source=manual", "s", "jump.height / jump.rsi", "E13"],
      ["HealthKit sleep stage", "sleep_record.stage_series / source=api", "min", "sleep.*", "E10"]
    ],
    pipeline: [
      ["① 采集", "BLE 通知 / 文件解析 / 表单提交 → RawSample，强制写 source 与 quality_flag"],
      ["② 时间对齐", "统一 ts_ms(UTC)，估计设备时钟漂移；重采样到统一栅格但缺测不插值"],
      ["③ 坐标与去重力（IMU）", "静止段估计重力向量 → 坐标对齐 → 去重力"],
      ["④ 滤波与积分（IMU）", "低通滤波（截止频率待真机标定）→ 积分得速度 → ZUPT 消漂移"],
      ["⑤ 事件切分", "速度阈值切分重复；视频按起跳 / 落地帧切分腾空与接触"],
      ["⑥ 纯函数计算", "vbt-engine / jump-engine / hrv-engine / sleep-engine / load-engine，输出带 calc_version"],
      ["⑦ 登记与审计", "metric-registry 登记公式 / 窗口 / 输入 / 证据编号；audit-log 留 request_id"],
      ["⑧ 事件分发", "SSE 推送 device.sample / import.progress / sync.done；worker 幂等 + 死信"],
      ["⑨ 单一快照", "LiveStore 保存不可变 snapshot + version，所有图表订阅同一版本"],
      ["⑩ 展示与下钻", "图表适配层读同一快照；任意值可下钻到原始样本与计算口径"]
    ],
    modules: [
      ["接入层", "ble-gateway / file-importer / api-connector / manual-entry", "只产出 RawSample，不写业务逻辑"],
      ["存储层", "timeseries-store / session-store / metric_definition", "原始样本只追加不覆盖；迁移可回滚"],
      ["计算层", "纯函数 + 显式 calc_version", "不依赖 UI、不依赖具体设备、可回归测试"],
      ["服务层", "metric-registry / rule-engine / audit-log", "四问准入：公式、窗口、输入、证据编号"],
      ["实时层", "SSE event bus / LiveStore / refresh controller", "单向推送、心跳、断线退避重连、按 version 补增量"],
      ["展示层", "chart adapter / tooltip / filter / state overlay", "筛选与悬停不回源；刷新全卡同步更新"],
      ["任务层", "worker（独立进程）/ DLQ", "幂等键 = import_id + calc_version，失败最多 3 次"]
    ],
    rules: [
      ["来源互斥", "同一指标 device / api / import / manual 在筛选时互斥，不合并计算"],
      ["缺测不补", "缺测写 NULL 并显示「—」；窗口指标有效天数不足返回不可计算，不补 0"],
      ["质量标记", "quality_flag ∈ valid / suspect / missing；suspect 进质量页，不静默丢弃"],
      ["冲突检测", "同一 ts_ms 多来源同指标时记录冲突，不自动覆盖，交人工或规则裁决"],
      ["版本一致", "每个派生值携带 calc_version；刷新时所有卡片切到同一 version"]
    ]
  };

  /* ── 3. 实时单一状态源 LiveStore ────────────────────────── */
  L.state = {
    live: true, version: 1, ts: hhmmss(), status: "ok",
    window: 28, source: "all", lastEvent: "device.sample", retry: 0
  };
  let subs = [], timer = null, renderer = null;
  L.setRenderer = fn => { renderer = fn; };
  L.subscribe = fn => { subs.push(fn); return () => { subs = subs.filter(x => x !== fn); }; };
  function emit() {
    const s = L.state;
    subs.forEach(f => { try { f(s); } catch (e) { /* 单个订阅者失败不影响其他 */ } });
    try { document.dispatchEvent(new CustomEvent("arc:live", { detail: s })); } catch (e) { /* noop */ }
    redraw();
  }
  L.emit = emit;
  L.setStatus = v => { L.state.status = v; L.state.version++; L.state.ts = hhmmss(); L.state.lastEvent = "state.demo/" + v; emit(); };
  L.setFilter = (k, v) => {
    L.state[k] = (k === "window") ? Number(v) : v;
    L.state.version++; L.state.ts = hhmmss(); L.state.lastEvent = "filter." + k + "=" + v; emit();
  };
  L.toggleLive = () => { L.state.live = !L.state.live; L.state.version++; L.state.ts = hhmmss(); L.state.lastEvent = L.state.live ? "stream.resume" : "stream.pause"; emit(); };
  L.refresh = () => {
    if (L.state.status === "loading") return;
    L.state.status = "loading"; L.state.version++; L.state.ts = hhmmss(); L.state.lastEvent = "manual.refresh"; emit();
    setTimeout(() => {
      L.state.status = "ok"; L.state.retry = 0; L.state.version++; L.state.ts = hhmmss();
      L.state.lastEvent = "manual.refresh.done"; emit();
    }, 420);
  };
  L.start = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (!L.state.live || L.state.status !== "ok") return;
      L.state.version++; L.state.ts = hhmmss(); L.state.lastEvent = "device.sample"; emit();
    }, 1000);
  };
  L.stop = () => { clearInterval(timer); timer = null; };

  /* ── 4. 筛选 / 实时抖动 / 状态覆盖 ──────────────────────── */
  const SRC_PATTERN = ["device", "device", "import", "device", "manual", "device", "import"];
  const srcAt = i => SRC_PATTERN[i % SRC_PATTERN.length];
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function applyView(base, st) {
    let c; try { c = clone(base); } catch (e) { return base; }
    const hasLabels = Array.isArray(c.labels) && c.labels.length > 0;
    let excluded = 0;
    // 窗口筛选：真实截断数据点
    if (hasLabels && st.window < c.labels.length && (c.kind === "line" || c.kind === "bars")) {
      const n = st.window;
      c.labels = c.labels.slice(-n);
      if (c.series) c.series.forEach(s => { if (Array.isArray(s.values)) s.values = s.values.slice(-n); });
      if (Array.isArray(c.values)) c.values = c.values.slice(-n);
      if (c.lines) c.lines.forEach(l => { if (Array.isArray(l.values)) l.values = l.values.slice(-n); });
      if (Array.isArray(c.bands)) c.bands = c.bands.slice(-n);
    }
    // 来源筛选：非匹配点置 null，图上以「—」空位呈现，不合并、不估算
    if (st.source !== "all" && (c.kind === "line" || c.kind === "bars")) {
      const n = c.labels ? c.labels.length : 0;
      const keep = i => srcAt(i) === st.source;
      if (c.series) c.series.forEach(s => { if (Array.isArray(s.values)) s.values = s.values.map((v, i) => keep(i) ? v : (excluded++, null)); });
      if (Array.isArray(c.values)) c.values = c.values.map((v, i) => keep(i) ? v : null);
      if (c.lines) c.lines.forEach(l => { if (Array.isArray(l.values)) l.values = l.values.map((v, i) => keep(i) ? v : null); });
      void n;
    }
    // 实时推流：仅扰动末点，模拟 SSE 增量；从当前值续播，不跳回 0
    if (st.live && c.kind !== "gauge" && c.kind !== "scatter") {
      const f = 1 + 0.012 * Math.sin(st.version / 3);
      const jitter = v => (v === null || v === undefined || !Number.isFinite(v)) ? v : Math.round(v * f * 100) / 100;
      if (c.series) c.series.forEach(s => { const a = s.values; if (a && a.length) { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null && Number.isFinite(a[i])) { a[i] = jitter(a[i]); break; } } });
      if (Array.isArray(c.values)) { for (let i = c.values.length - 1; i >= 0; i--) if (c.values[i] !== null && Number.isFinite(c.values[i])) { c.values[i] = jitter(c.values[i]); break; } }
    }
    c.arcMeta = { version: st.version, window: st.window, source: st.source, excluded: excluded, ts: st.ts };
    return c;
  }
  L.applyView = applyView;

  /* ── 5. 交互：悬停十字线 + 详情浮层（触屏点按 / 键盘方向键） ── */
  function tipHtml(c, i) {
    const m = c.arcMeta || { version: L.state.version, window: L.state.window, source: L.state.source, ts: L.state.ts };
    const label = (c.labels && c.labels[i]) || ("#" + (i + 1));
    let rows = "";
    if (c.series) rows = c.series.map(s => {
      const v = s.values && s.values[i];
      return '<div class="ct-row"><span><i style="background:' + esc(s.color) + '"></i>' + esc(s.name) + '</span><b>' + (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v).toFixed(2)) + '</b></div>';
    }).join("");
    else if (Array.isArray(c.values)) {
      const v = c.values[i];
      rows = '<div class="ct-row"><span>数值</span><b>' + (v === null || !Number.isFinite(v) ? "—" : Number(v).toFixed(2)) + '</b></div>';
    } else if (c.points) {
      const p = c.points[i];
      rows = p ? '<div class="ct-row"><span>负荷</span><b>' + p.x + ' kg</b></div><div class="ct-row"><span>MPV</span><b>' + p.y.toFixed(2) + ' m/s</b></div>' : "";
    } else if (c.rows) {
      const r = c.rows[i];
      rows = r ? '<div class="ct-row"><span>' + esc(r.label) + '</span><b>' + (r.parts ? r.parts.reduce((a, b) => a + b.v, 0) + " min" : "— 缺测") + '</b></div>' : "";
    } else if (c.items) {
      rows = c.items.map(it => '<div class="ct-row"><span>' + esc(it.name) + '</span><b>' + (it.value === null ? "—" : Number(it.value).toFixed(2)) + '</b></div>').join("");
    }
    const src = m.source === "all" ? "device / import / manual" : m.source;
    return '<div class="ct-head">' + esc(label) + ' · ' + DEMO + '</div>' + rows +
      '<div class="ct-meta">口径 ' + esc(c.drillId || "见指标口径 Registry") + ' · 窗口 ' + (m.window || 28) + ' 日 · 来源 ' + esc(src) + '</div>' +
      '<div class="ct-meta">quality_flag ' + (srcAt(i) === "manual" ? "valid" : "valid") + ' · v' + (m.version || 1) + ' · ' + esc(m.ts || "") + '</div>' +
      '<div class="ct-foot">点按指标卡的「ⓘ 口径」可下钻公式与原始样本</div>';
  }
  function showTip(host, i) {
    const c = host.__arcCfg; if (!c) return;
    const n = (c.labels && c.labels.length) || (c.values && c.values.length) || (c.points && c.points.length) || (c.rows && c.rows.length) || (c.items && c.items.length) || 1;
    i = Math.max(0, Math.min(n - 1, i));
    const cross = host.querySelector(".chart-cross"), tip = host.querySelector(".chart-tip");
    if (!cross || !tip) return;
    const w = host.clientWidth || 300, padL = 36, padR = 12;
    const x = padL + (w - padL - padR) * (n === 1 ? 0 : i / (n - 1));
    cross.style.left = x.toFixed(1) + "px"; cross.style.opacity = "1";
    tip.innerHTML = tipHtml(c, i); tip.style.opacity = "1";
    const tw = 210;
    tip.style.left = Math.max(4, Math.min(w - tw - 4, x - tw / 2)) + "px";
    tip.style.top = "8px";
    host.__arcIndex = i;
  }
  function hideTip(host) {
    const c = host.querySelector(".chart-cross"), t = host.querySelector(".chart-tip");
    if (c) c.style.opacity = "0"; if (t) t.style.opacity = "0";
  }
  function onMove(e) {
    const host = e.currentTarget, c = host.__arcCfg; if (!c) return;
    const r = host.getBoundingClientRect();
    const n = (c.labels && c.labels.length) || (c.values && c.values.length) || (c.points && c.points.length) || (c.rows && c.rows.length) || (c.items && c.items.length) || 1;
    const x = e.clientX - r.left, padL = 36, padR = 12, w = r.width;
    const i = Math.max(0, Math.min(n - 1, Math.round((x - padL) / Math.max(1, w - padL - padR) * (n - 1))));
    showTip(host, i);
  }
  function decorate(host, cfg) {
    host.__arcCfg = cfg;
    host.dataset.liveChart = "1";
    host.tabIndex = 0;
    host.setAttribute("aria-label", "实时交互图表，可用左右方向键查看逐点详情");
    if (!host.__arcDecorated) {
      host.__arcDecorated = true;
      host.addEventListener("mousemove", onMove);
      host.addEventListener("mouseleave", () => hideTip(host));
      host.addEventListener("click", e => {
        const cc = host.__arcCfg || cfg;
        const r = host.getBoundingClientRect();
        const n = (cc.labels && cc.labels.length) || (cc.values && cc.values.length) || (cc.points && cc.points.length) || 1;
        showTip(host, Math.round((e.clientX - r.left - 36) / Math.max(1, r.width - 48) * (n - 1)));
      });
      host.addEventListener("keydown", e => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault(); e.stopPropagation();
          showTip(host, (host.__arcIndex || 0) + (e.key === "ArrowRight" ? 1 : -1));
        }
        if (e.key === "Escape") hideTip(host);
      });
    }
    if (!host.querySelector(".chart-tip")) {
      const t = document.createElement("div"); t.className = "chart-tip"; host.appendChild(t);
      const c = document.createElement("div"); c.className = "chart-cross"; host.appendChild(c);
    }
    applyState(host);
  }
  L.decorate = decorate;

  /* ── 6. 空 / 加载 / 异常 / 离线 状态覆盖 ─────────────────── */
  function applyState(host) {
    const old = host.querySelector(".chart-state"); if (old) old.remove();
    const oldTag = host.querySelector(".offline-tag"); if (oldTag) oldTag.remove();
    host.classList.remove("is-offline");
    const st = L.state.status;
    if (st === "offline") {
      host.classList.add("is-offline");
      const tag = document.createElement("div"); tag.className = "offline-tag";
      tag.innerHTML = '离线 · 本地快照 ' + esc(L.state.ts) + " · " + DEMO;
      host.appendChild(tag);
      return;
    }
    if (st === "ok") return;
    const d = document.createElement("div"); d.className = "chart-state";
    if (st === "loading") {
      d.innerHTML = '<div class="skel-bars">' + [52, 74, 44, 88, 62, 96, 70, 84].map(h => '<i style="height:' + h + '%"></i>').join("") + '</div>' +
        '<div class="st-text"><b>正在同步…</b><span>首次加载超过 200 ms 才显示骨架；超过 8 s 转异常</span></div>';
    } else if (st === "empty") {
      d.innerHTML = '<div class="st-ico">◌</div><div class="st-text"><b>暂无数据</b><span>真无数据：不显示 0，不估算</span></div>' +
        '<button class="btn sm" data-act="nav" data-route="data/import">去录入</button>';
    } else if (st === "error") {
      d.innerHTML = '<div class="st-ico bad">!</div><div class="st-text"><b>数据加载失败</b><span>5xx 已退避重试 3 次；4xx 不重试。保留上一版快照</span></div>' +
        '<button class="btn sm" data-act="live-refresh">重试</button>';
    }
    host.appendChild(d);
  }
  L.applyState = applyState;

  function redraw() {
    if (!renderer) return;
    document.querySelectorAll("#content [data-live-chart]").forEach(host => {
      const base = host.__arcBaseCfg; if (!base) return;
      const c = applyView(base, L.state);
      const W = Math.max(200, host.clientWidth || 360), H = Math.max(120, host.clientHeight || 200);
      host.innerHTML = renderer(c, W, H);
      decorate(host, c);
    });
    // 状态一致性：同一 version 刷新所有实时读数
    document.querySelectorAll("[data-live-version]").forEach(el => { el.textContent = "v" + L.state.version; });
    document.querySelectorAll("[data-live-ts]").forEach(el => { el.textContent = L.state.ts; });
    document.querySelectorAll("[data-live-event]").forEach(el => { el.textContent = L.state.lastEvent; });
    document.querySelectorAll("[data-live-dot]").forEach(el => { el.classList.toggle("on", L.state.live && L.state.status === "ok"); });
    document.querySelectorAll("[data-live-label]").forEach(el => { el.textContent = L.state.live ? "实时 · 1 Hz" : "已暂停"; });
    document.querySelectorAll("[data-live-filter]").forEach(el => {
      const k = el.dataset.liveFilter, v = el.dataset.v;
      const cur = String(L.state[k]);
      el.classList.toggle("on", cur === String(v));
    });
    document.querySelectorAll("[data-live-status]").forEach(el => { el.classList.toggle("on", el.dataset.liveStatus === L.state.status); });
    document.querySelectorAll(".lb-actions [data-act='live-toggle']").forEach(el => { el.textContent = L.state.live ? "暂停推流" : "继续推流"; });
    document.querySelectorAll("[data-live-note]").forEach(el => { el.textContent = L.stateOverlayNote(); });
    // 窗口单一数据源：实时控制条变更后，页首芯片与 O6 选择器即时同步
    document.querySelectorAll("[data-live-window]").forEach(el => { el.textContent = "窗口 · " + L.state.window + " 日"; });
    document.querySelectorAll('#overlay [data-key="window"]').forEach(el => { el.value = String(L.state.window); });
  }
  L.redraw = redraw;
  L.attachBase = (host, cfg) => { host.__arcBaseCfg = cfg; };
  L.stateOverlayNote = () => {
    const s = L.state.status;
    const map = {
      ok: "正常：SSE 增量 1 Hz，筛选与悬停客户端即时响应，全部卡片共用同一 version。",
      loading: "加载中：骨架占位保持卡片尺寸，避免布局跳动；>8 s 转异常。",
      empty: "空：区分「真无数据」与「筛选后无结果」；后者提供「清除筛选」，不显示 0。",
      error: "异常：4xx 不重试并给可读原因；5xx 最多 3 次退避；保留上一版快照，不做静默吞错。",
      offline: "离线：显示本地缓存快照并标注时间，恢复连接后按 version 补齐增量。"
    };
    return map[s] || map.ok;
  };

  /* ── 7. 实时控制条 HTML ─────────────────────────────────── */
  L.barHtml = function () {
    const s = L.state;
    const seg = (key, list) => list.map(x => '<button class="lb-seg ' + (String(s[key]) === String(x[0]) ? "on" : "") + '" data-act="live-filter" data-live-filter="' + key + '" data-k="' + key + '" data-v="' + x[0] + '">' + x[1] + '</button>').join("");
    const status = [["ok", "正常"], ["loading", "加载中"], ["empty", "空数据"], ["error", "异常"], ["offline", "离线"]].map(x =>
      '<button class="lb-seg ' + (s.status === x[0] ? "on" : "") + '" data-act="live-status" data-live-status="' + x[0] + '">' + x[1] + '</button>').join("");
    return '<div class="livebar card span-3">' +
      '<div class="lb-top"><span class="live-dot ' + (s.live && s.status === "ok" ? "on" : "") + '" data-live-dot></span>' +
      '<div class="lb-title"><b data-live-label>' + (s.live ? "实时 · 1 Hz" : "已暂停") + '</b><span>SSE 仿真 · <span data-live-version>v' + s.version + '</span> · 最后更新 <span data-live-ts>' + s.ts + '</span> · 事件 <span data-live-event>' + esc(s.lastEvent) + '</span></span></div>' +
      '<div class="lb-actions">' +
      '<button class="btn sm" data-act="live-toggle">' + (s.live ? "暂停推流" : "继续推流") + '</button>' +
      '<button class="btn sm primary" data-act="live-refresh">↻ 即时刷新</button>' +
      '<button class="btn sm" data-act="sheet" data-sheet="scores">对标评分与阈值</button>' +
      '<button class="btn sm" data-act="sheet" data-sheet="fusion">数据融合与映射</button>' +
      '</div></div>' +
      '<div class="lb-filters"><span class="lb-k">窗口</span><div class="lb-seg-wrap">' + seg("window", [[7, "7 日"], [28, "28 日"], [42, "42 日"], [90, "90 日"]]) + '</div>' +
      '<span class="lb-k">来源</span><div class="lb-seg-wrap">' + seg("source", [["all", "全部"], ["device", "device"], ["import", "import"], ["manual", "manual"]]) + '</div>' +
      '<span class="lb-k">状态示例</span><div class="lb-seg-wrap">' + status + '</div></div>' +
      '<div class="lb-note">' + DEMO + ' <span data-live-note>' + esc(L.stateOverlayNote()) + '</span></div>' +
      '</div>';
  };
  L.updateBarNote = function () {
    document.querySelectorAll("[data-live-note]").forEach(el => { el.textContent = L.stateOverlayNote(); });
  };

  /* ── 8. 对标评分卡片 HTML ──────────────────────────────── */
  function bandBar(s) {
    const [a, b] = s.range, span = Math.max(1, b - a);
    const segs = s.bands.map(x => {
      const w = (x.hi - x.lo + (s.categorical ? 0 : (x.hi === x.lo ? 0.6 : 0))) / span * 100;
      return '<i class="bb-' + esc(x.tone) + '" style="width:' + Math.max(3, w).toFixed(1) + '%" title="' + esc(x.zh + " " + x.lo + "–" + x.hi) + '"></i>';
    }).join("");
    let marker = "";
    if (!s.categorical && s.value !== null) {
      const p = Math.max(0, Math.min(100, (s.value - a) / span * 100));
      marker = '<span class="bb-marker" style="left:' + p.toFixed(1) + '%"></span>';
    }
    return '<div class="bandbar">' + segs + marker + '</div>';
  }
  L.bandBar = bandBar;
  L.scoreCardsHtml = function (ids) {
    const list = (ids && ids.length ? ids : L.SCORES.map(s => s.id)).map(id => L.SCORE_BY_ID[id]).filter(Boolean);
    return '<div class="card span-3 score-section"><div class="section-head"><h3 class="section-title">对标评分 · 原型级占位还原</h3>' +
      '<span class="section-sub">公开可查的分档标签与状态含义 · 数值全部为 DEMO 占位</span>' +
      '<div class="section-tools"><button class="chip" data-act="sheet" data-sheet="scores">ⓘ 阈值全表与依据等级</button></div></div>' +
      '<div class="score-grid">' + list.map(s => {
        const bd = bandOf(s, s.value);
        return '<div class="score-card" role="button" tabindex="0" data-act="sheet" data-sheet="scores" data-id="' + esc(s.id) + '">' +
          '<div class="sc-head"><span class="sc-name">' + esc(s.name) + '</span><span class="sc-vendor">' + esc(s.vendor) + '</span>' + DEMO + '</div>' +
          '<div class="sc-value">' + (s.value === null ? "—" : esc(s.value)) + (s.unit ? '<span>' + esc(s.unit) + '</span>' : "") + '</div>' +
          '<div class="sc-status">' + (bd ? '<b class="tone-' + esc(bd.tone) + '">' + esc(bd.label) + " · " + esc(bd.zh) + '</b>' : "") + '<span>' + esc(s.status) + '</span></div>' +
          bandBar(s) +
          '<div class="sc-meaning">' + esc(bd ? bd.meaning : s.meaning) + '</div>' +
          '<div class="sc-foot">口径 ' + esc(s.basis.split(" · ")[0]) + ' 级 · 占位值，非厂商算法输出</div></div>';
      }).join("") + '</div>' +
      '<div class="card-note">以上为<b>原型级展示还原</b>：仅采用公开文档可查的名称、分档与状态含义，DEMO 数值由占位生成器给出，<b>不实现也不宣称还原</b> EPOC / Firstbeat / 自适应基线等真实算法；不构成训练或医学建议。ARC 自身决策层仍使用可解释规则（今日主状态与 R-xx 规则）。</div></div>';
  };

  L.scoresSheetHtml = function (focusId) {
    const order = focusId && L.SCORE_BY_ID[focusId] ? [L.SCORE_BY_ID[focusId]].concat(L.SCORES.filter(s => s.id !== focusId)) : L.SCORES;
    return '<div class="note warn"><div class="note-title">⚠ 公开口径说明边界</div>下表只复现<b>公开资料可查的名称、阈值分档与状态含义</b>，用于界面与信息层级对标评估。所有数值为 DEMO 占位，由原型生成器给出，<b>与任何厂商设备的真实输出无对应关系</b>；不实现 EPOC、Firstbeat、自适应基线等真实算法，不输出医学结论，不构成训练或医学建议。</div>' +
      order.map(s => '<div class="sheet-section-title">' + esc(s.name) + ' <span class="chip demo">DEMO</span></div>' +
        '<dl class="kv"><dt>厂商 / 刻度</dt><dd>' + esc(s.vendor) + ' · ' + esc(s.range[0]) + '–' + esc(s.range[1]) + ' ' + esc(s.unit) + '</dd>' +
        '<dt>公开口径</dt><dd>' + esc(s.definition) + '</dd>' +
        '<dt>原型占位值</dt><dd><b>' + (s.value === null ? "—（分类量）" : esc(s.value) + " " + esc(s.unit)) + '</b> · 当前状态：' + esc(s.status) + ' ' + DEMO + '</dd>' +
        '<dt>依据等级</dt><dd>' + esc(s.basis) + '</dd>' +
        '<dt>公开来源</dt><dd>' + s.refs.map(esc).join(" · ") + '</dd></dl>' +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>分档 / 区间</th><th>状态</th><th>状态含义（公开表述）</th></tr></thead><tbody>' +
        s.bands.map(b => '<tr><td>' + (s.categorical ? esc(b.zh) : esc(b.lo) + ' – ' + esc(b.hi)) + '</td><td><b>' + esc(b.label) + ' · ' + esc(b.zh) + '</b></td><td><span class="mini">' + esc(b.meaning) + '</span></td></tr>').join("") +
        '</tbody></table></div>' +
        (s.diff ? '<div class="note" style="margin-top:8px"><b>公开资料差异标注</b>：' + esc(s.diff) + '</div>' : "")).join("") +
      '<div class="sheet-section-title">还原范围与不还原范围</div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>项</th><th>本原型</th></tr></thead><tbody>' +
      [["评分名称 / 分档标签 / 状态含义", "✅ 公开口径说明（公开可查部分）"], ["阈值区间与档位数", "✅ 公开口径说明；官方资料存在差异时并列标注，不合并"], ["DEMO 占位数值", "✅ 统一标记，占位生成器给出"], ["真实算法（EPOC / Firstbeat / 自适应基线）", "❌ 不实现、不宣称还原、不编造"], ["厂商界面资产 / 图标 / 配色素材", "❌ 不复制，使用 ARC 自有组件"], ["医学结论与诊断", "❌ 不输出"], ["厂商云端 API 真实数据", "❌ 未授权前不接入"]].map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join("") +
      '</tbody></table></div>';
  };

  /* ── 9. 数据融合 HTML ──────────────────────────────────── */
  L.fusionHtml = function (compact) {
    const F = L.FUSION;
    const tbl = (cols, rows) => '<div class="table-wrap"><table class="tbl"><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join("") + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => '<td><span class="mini">' + esc(c) + '</span></td>').join("") + '</tr>').join("") + '</tbody></table></div>';
    let h = '<div class="note info"><b>还原范围</b>：以下为<b>自研原型实现要点（对标能力域）</b>——数据来源清单、字段映射、处理链与模块边界，按公开口径说明呈现。<b>不是任何厂商 App 内部实现或传感器融合标定的还原</b>；未取得授权前不接入厂商云端 API，专有融合参数留空不猜测。</div>';
    h += '<div class="sheet-section-title">① 数据来源清单 ' + DEMO + '</div>' + tbl(["来源", "协议 / 格式", "采样率", "source", "字段"], F.sources);
    h += '<div class="sheet-section-title">② 字段映射（源字段 → 统一时序 → 派生指标）</div>' + tbl(["源字段", "统一字段 / stream_type", "单位", "派生指标", "证据"], F.mapping);
    if (!compact) {
      h += '<div class="sheet-section-title">③ 传感器融合与处理链（IMU / 视频 / 时序对齐）</div>' + tbl(["步骤", "自研原型实现要点"], F.pipeline);
      h += '<div class="sheet-section-title">④ App 内部实现要点（分层与模块边界）</div>' + tbl(["层", "模块", "职责约束"], F.modules);
      h += '<div class="sheet-section-title">⑤ 治理规则</div>' + tbl(["规则", "约束"], F.rules);
      h += '<div class="sheet-section-title">⑥ 原型内部实现锚点</div><div class="formula">prototype/live.js → ARC_LIVE.state（单一快照 + version）\nprototype/app.js → renderChart / mountCharts / ARC.adapter（替换点）\nserver → features/ingest · core-metrics（纯函数） · realtime/sse · worker（幂等 + DLQ）\ndata.js → METRICS（metric-registry 四问准入）</div>';
    }
    return h;
  };
  L.fusionSectionHtml = function () {
    return '<div class="card span-3 fusion-section"><div class="section-head"><h3 class="section-title">数据融合与字段映射 · 公开口径说明</h3>' +
      '<span class="section-sub">来源 → 统一时序 → 派生指标</span><div class="section-tools"><button class="chip" data-act="sheet" data-sheet="fusion">ⓘ 完整实现要点</button></div></div>' +
      L.fusionHtml(true) +
      '<div class="card-note">全部为自研原型实现要点，不是厂商 App 内部实现还原；示例字段与数值均为 DEMO。</div></div>';
  };

  window.ARC_LIVE = L;
})();
