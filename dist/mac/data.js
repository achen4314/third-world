/* ARC 训练 · 原型数据层 (DEMO)
 * 所有数值均为演示样例，不是真实运动数据，不构成训练或医学建议。
 * 本文件不包含任何竞品专有算法或评分。
 */
(function () {
  "use strict";

  const DAY_MS = 86400000;
  const START = Date.UTC(2026, 9, 17); // 2026-10-17
  const DATES = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(START + i * DAY_MS);
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
  });
  const DATES_FULL = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(START + i * DAY_MS);
    return d.getUTCFullYear() + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0");
  });

  // 28 日 TL。null = 缺测（不是 0）；0 = 记录过的休息日。
  const TL_BASE = [
    78, 112, 64, 0, 96, 128, 88, 0, null, 104, 136, 92, 0, 118,
    142, 76, 0, null, 122, 150, 98, 0, 110, 138, 84, 0, 96, 118
  ];

  const RMSSD_BASE = [
    58, 61, 63, 66, 59, 54, 62, 65, null, 60, 52, 57, 68, 64,
    55, 58, 66, null, 61, 49, 56, 67, 63, 58, 54, 70, 66, 64
  ];

  const SLEEP = [
    { date: "11/07", tst: 452, waso: 34, eff: 0.90, awake: 2, stages: [92, 246, 114, 34], src: "device" },
    { date: "11/08", tst: 388, waso: 52, eff: 0.84, awake: 4, stages: [70, 218, 100, 52], src: "device" },
    { date: "11/09", tst: 476, waso: 22, eff: 0.94, awake: 1, stages: [104, 262, 110, 22], src: "device" },
    { date: "11/10", tst: null, waso: null, eff: null, awake: null, stages: null, src: "missing" },
    { date: "11/11", tst: 431, waso: 41, eff: 0.88, awake: 3, stages: [84, 238, 109, 41], src: "manual" },
    { date: "11/12", tst: 464, waso: 28, eff: 0.92, awake: 2, stages: [98, 252, 114, 28], src: "device" },
    { date: "11/13", tst: 409, waso: 46, eff: 0.86, awake: 3, stages: [76, 226, 107, 46], src: "device" }
  ];

  const VBT_SETS = [
    { load: 40, mpv: 0.98, mcv: 0.94, pv: 1.32, vl: 6.1, p: 384 },
    { load: 60, mpv: 0.82, mcv: 0.79, pv: 1.14, vl: 9.4, p: 482 },
    { load: 80, mpv: 0.66, mcv: 0.63, pv: 0.95, vl: 13.2, p: 518 },
    { load: 100, mpv: 0.51, mcv: 0.49, pv: 0.76, vl: 18.7, p: 502 },
    { load: 120, mpv: 0.36, mcv: 0.34, pv: 0.58, vl: 24.3, p: 424 }
  ];

  const JUMPS = [
    { date: "11/13", type: "CMJ", tf: 0.512, tc: null, method: "video", fps: 240, cond: "木地板 / 室内 / 09:10" },
    { date: "11/13", type: "SJ", tf: 0.468, tc: null, method: "video", fps: 240, cond: "木地板 / 室内 / 09:10" },
    { date: "11/13", type: "DJ", tf: 0.398, tc: 0.184, method: "imu", fps: null, cond: "木地板 / 室内 / 09:20" },
    { date: "11/11", type: "CMJ", tf: 0.498, tc: null, method: "manual", fps: null, cond: "胶垫 / 室内 / 08:50" },
    { date: "11/06", type: "RSI 10-5", tf: 0.341, tc: 0.172, method: "imu", fps: null, cond: "木地板 / 室内 / 09:05" },
    { date: "10/30", type: "CMJ", tf: 0.486, tc: null, method: "video", fps: 240, cond: "木地板 / 室内 / 09:00" },
    { date: "10/30", type: "SJ", tf: 0.451, tc: null, method: "video", fps: 240, cond: "木地板 / 室内 / 09:00" },
    { date: "10/23", type: "DJ", tf: 0.382, tc: 0.196, method: "manual", fps: null, cond: "胶垫 / 室内 / 08:40" }
  ];

  const DEVICES = [
    { id: "hr-001", name: "心率带 HR-01", kind: "心率带", proto: "BLE 0x180D / 0x2A37", rate: "1 Hz", battery: 82, status: "online", last: "2 分钟前", src: "device" },
    { id: "tr-002", name: "骑行台 TR-02", kind: "骑行台 / 功率计", proto: "FTMS 0x1826 / 0x2AD2", rate: "4 Hz", battery: null, status: "online", last: "12 分钟前", src: "device" },
    { id: "tm-003", name: "跑步机 TM-03", kind: "跑步机", proto: "FTMS 0x2ACD · RSC 0x1814", rate: "1 Hz", battery: null, status: "warn", last: "3 天前", src: "device" },
    { id: "wt-004", name: "运动手表 WT-04", kind: "运动手表", proto: "FIT / TCX 文件导入", rate: "会话级", battery: 61, status: "online", last: "昨天 21:40", src: "import" },
    { id: "imu-001", name: "VBT IMU · imu-001", kind: "VBT IMU", proto: "CSV / JSON 拉取 · 200 Hz", rate: "200 Hz", battery: 74, status: "online", last: "今天 09:12", src: "import" },
    { id: "cam-005", name: "高帧率视频采集", kind: "视频 / 帧标记", proto: "手动标记起跳帧 / 落地帧", rate: "240 fps", battery: null, status: "offline", last: "11/13 09:10", src: "manual" },
    { id: "api-006", name: "厂商云端 API", kind: "授权数据源", proto: "需开发者授权", rate: "—", battery: null, status: "locked", last: "未申请", src: "api" }
  ];

  const SOURCES = [
    { name: "FIT / TCX / GPX 导出文件", state: "可用", note: "用户自有设备导出 · 无需厂商授权", src: "import" },
    { name: "IMU CSV / JSON 采样", state: "可用", note: "统一 schema：ts_ms / ax / ay / az / gx / gy / gz", src: "import" },
    { name: "手动录入", state: "可用", note: "写入 source=manual，与 import 互斥筛选", src: "manual" },
    { name: "Apple HealthKit", state: "未授予", note: "需用户在使用上下文中授权", src: "api" },
    { name: "Android Health Connect", state: "不适用", note: "当前端未接入", src: "api" },
    { name: "COROS 开放平台 API", state: "未申请", note: "需向厂商申请开发者授权", src: "api" },
    { name: "Garmin Connect Developer Program", state: "未申请", note: "需向厂商申请开发者授权", src: "api" },
    { name: "ANT+", state: "需授权", note: "协议授权未取得前不假设可用", src: "api" }
  ];

  const SESSIONS = [
    { date: "11/13", name: "力量 · 下肢 VBT", sport: "力量", dur: "68 min", tl: 96, method: "sRPE", rpe: 7, src: "device" },
    { date: "11/12", name: "节奏跑 20' + 6×400m", sport: "跑步", dur: "72 min", tl: 0, method: "休息日", rpe: 0, src: "manual" },
    { date: "11/11", name: "有氧基础 Z2", sport: "跑步", dur: "64 min", tl: 84, method: "TRIMP", rpe: 5, src: "device" },
    { date: "11/10", name: "室内骑行 · 阈值间歇", sport: "骑行", dur: "81 min", tl: 138, method: "TSS", rpe: 8, src: "device" },
    { date: "11/09", name: "低强度恢复跑", sport: "跑步", dur: "35 min", tl: 110, method: "sRPE", rpe: 4, src: "import" },
    { date: "11/08", name: "长距离有氧", sport: "跑步", dur: "104 min", tl: 0, method: "休息日", rpe: 0, src: "manual" },
    { date: "11/07", name: "上肢力量 + 核心", sport: "力量", dur: "55 min", tl: 98, method: "sRPE", rpe: 6, src: "device" }
  ];

  const PLAN_BLOCKS = [
    { phase: "Base", range: "10/13 – 11/02", target: 96, status: "已完成", tone: "done" },
    { phase: "Build", range: "11/03 – 11/23", target: 118, status: "进行中", tone: "active" },
    { phase: "Peak", range: "11/24 – 12/07", target: 132, status: "计划", tone: "plan" },
    { phase: "Taper", range: "12/08 – 12/14", target: 78, status: "计划", tone: "plan" },
    { phase: "Deload", range: "12/15 – 12/21", target: 58, status: "计划", tone: "plan" }
  ];

  const ATHLETES = [
    { name: "林 澈", squad: "A 组", load7: 612, acwr: 1.34, complete: 0.92, quality: 0.96, flag: "需关注" },
    { name: "周 珩", squad: "A 组", load7: 548, acwr: 1.08, complete: 1.00, quality: 0.98, flag: "正常" },
    { name: "陈 屿", squad: "A 组", load7: 431, acwr: 0.86, complete: 0.86, quality: 0.79, flag: "缺测" },
    { name: "许 昭", squad: "B 组", load7: 587, acwr: 1.19, complete: 0.94, quality: 0.97, flag: "正常" },
    { name: "沈 砚", squad: "B 组", load7: 392, acwr: 0.74, complete: 0.71, quality: 0.88, flag: "需关注" },
    { name: "叶 岑", squad: "B 组", load7: 520, acwr: 1.02, complete: 0.98, quality: 0.99, flag: "正常" },
    { name: "苏 迟", squad: "康复组", load7: 214, acwr: null, complete: 0.64, quality: 0.62, flag: "数据不足" },
    { name: "顾 昀", squad: "康复组", load7: 356, acwr: 0.91, complete: 0.88, quality: 0.94, flag: "正常" }
  ];

  const AUDIT = [
    { ts: "11/13 09:14", actor: "head_coach", action: "口径版本切换", target: "acwr.ewma v1.0", result: "成功", rid: "rq_8f21" },
    { ts: "11/13 09:02", actor: "coach", action: "写入手动录入", target: "jump_test / 11/13 CMJ", result: "成功", rid: "rq_8f0a" },
    { ts: "11/12 21:40", actor: "system", action: "导入 FIT 文件", target: "session / 11/12", result: "成功", rid: "rq_7d9c" },
    { ts: "11/12 18:03", actor: "analyst", action: "导出 CSV", target: "analysis/load 28d", result: "成功", rid: "rq_7c11" },
    { ts: "11/11 14:26", actor: "medical", action: "尝试编辑周期计划", target: "plan_block / Build", result: "拒绝 403", rid: "rq_7b45" },
    { ts: "11/10 08:12", actor: "admin", action: "设备解绑", target: "device / tm-003", result: "成功", rid: "rq_6a88" },
    { ts: "11/09 11:50", actor: "system", action: "日负荷聚合", target: "daily_load / 11/09", result: "重试 1 次后成功", rid: "rq_69f0" },
    { ts: "11/08 07:30", actor: "head_coach", action: "审批周期块", target: "plan_block / Build", result: "成功", rid: "rq_681d" }
  ];

  const RULES = {
    "R-01": {
      title: "负荷增量规则",
      input: "CTL 14 日斜率 +0.9 / 日；ACWR(EWMA) 1.12",
      threshold: "斜率 ≤ +1.5 / 日 且 ACWR ∈ [0.80, 1.30]",
      conclusion: "当前增量在耐受范围内，维持本周目标日 TL 118",
      action: "维持计划",
      version: "rule-engine v1.0"
    },
    "R-04": {
      title: "恢复偏离规则",
      input: "lnRMSSD 4.16；28 日基线 4.08 ± 0.21；TST 409 min",
      threshold: "基线 ±1 SD 内且 TST ≥ 390 min",
      conclusion: "恢复未显著偏离个人基线，可执行既定强度",
      action: "允许既定强度",
      version: "rule-engine v1.0"
    },
    "R-07": {
      title: "单调性风险规则",
      input: "TM 1.42；TS 872；7 日有效天数 7",
      threshold: "TM < 2.0 且 TS < 10000",
      conclusion: "负荷分布未过度单调，无需插入额外休息日",
      action: "不插入 deload",
      version: "rule-engine v1.0"
    },
    "R-12": {
      title: "数据充分性规则",
      input: "28 日有效天数 26；7 日有效天数 7",
      threshold: "rolling ACWR 慢性窗 ≥ 26 有效天",
      conclusion: "慢性窗有效天数刚好满足下限，rolling 口径可用但灵敏度下降；以 EWMA 为主口径",
      action: "主口径：ACWR(EWMA)",
      version: "rule-engine v1.0"
    }
  };

  // metric-registry：每个指标回答「公式 / 窗口 / 输入 / 证据编号」四问
  const METRICS = {
    "acwr.ewma": {
      name: "ACWR（EWMA，别名 AWCR）", short: "ACWR EWMA",
      formula: "acute_t = acute_(t-1) + 0.25 × (TL_t − acute_(t-1))；chronic_t = chronic_(t-1) + 0.069 × (TL_t − chronic_(t-1))；ACWR = acute / chronic",
      window: "λ = 2/(7+1) 与 2/(28+1)", inputs: "每日 TL、TL 口径版本", evidence: "E8 (Gabbett 2016 / Williams 2017)",
      version: "v1.0", valid: "缺测日不参与更新、不补 0；有效天数不足时不输出数值",
      note: "推荐主口径。rolling 版急性窗包含在慢性窗内存在数学耦合，因此同时展示两口径差异，不单独给「甜蜜区间」结论。"
    },
    "acwr.rolling": {
      name: "ACWR（rolling 7/28）", short: "ACWR rolling",
      formula: "mean(TL, 7 日) / mean(TL, 28 日)", window: "7 / 28 日",
      inputs: "每日 TL", evidence: "E8", version: "v1.0",
      valid: "急性窗需 7/7 有效天，慢性窗需 ≥26/28 有效天，否则「不可计算」",
      note: "与 EWMA 并列展示，用于观察数学耦合带来的差异。"
    },
    "tl.srpe": {
      name: "单次训练负荷 TL（sRPE）", short: "TL sRPE",
      formula: "TL = sRPE(1–10) × 时长(min)", window: "单次",
      inputs: "主观 RPE、时长", evidence: "E6 (Foster 2001)", version: "v1.0",
      valid: "RPE 缺失时不可计算；一次只选一种 TL 口径并固定展示",
      note: "三口径（TRIMP / sRPE / TSS）不混用；无功率数据不得用 TSS。"
    },
    "tl.tss": {
      name: "单次训练负荷 TL（TSS）", short: "TL TSS",
      formula: "IF = NP/FTP；TSS = t_sec × NP × IF / (FTP × 3600) × 100；NP 为 30 s 滚动功率的 4 次方均值再开 4 次方",
      window: "单次", inputs: "功率时序、FTP", evidence: "E7 (Allen & Coggan)", version: "v1.0",
      valid: "无功率数据 → 不可计算，不得回退 TRIMP 冒充", note: "示例：无功率的跑步课只用 sRPE / TRIMP。"
    },
    "ctl": {
      name: "CTL（长期负荷）", short: "CTL",
      formula: "CTL_t = CTL_(t-1) + (TL_t − CTL_(t-1)) / 42", window: "42 日 EWMA",
      inputs: "每日 TL", evidence: "E7", version: "v1.0",
      valid: "缺测日沿用前值但不计入有效天数", note: "与 ATL、TSB 同口径版本展示。"
    },
    "atl": { name: "ATL（短期负荷）", short: "ATL", formula: "ATL_t = ATL_(t-1) + (TL_t − ATL_(t-1)) / 7", window: "7 日 EWMA", inputs: "每日 TL", evidence: "E7", version: "v1.0", valid: "同上", note: "收敛快于 CTL。" },
    "tsb": { name: "TSB（负荷平衡）", short: "TSB", formula: "TSB_t = CTL_(t-1) − ATL_(t-1)", window: "日", inputs: "CTL、ATL", evidence: "E7", version: "v1.0", valid: "采用前一日差值口径，避免当日稀释；口径固定并在页面展示", note: "正负由数值与文字说明，不靠颜色判定好坏。" },
    "tm": { name: "TM（训练单调性）", short: "TM", formula: "TM = mean(TL, 7 日) / sd(TL, 7 日)", window: "7 日", inputs: "每日 TL", evidence: "E6", version: "v1.0", valid: "sd = 0 → 不可计算；7 日有效天不足 → 不可计算；不得输出 0 或 Infinity", note: "用例 3：连续 7 天 TL=100 时应返回不可计算。" },
    "ts": { name: "TS（训练压力）", short: "TS", formula: "TS = sum(TL, 7 日) × TM", window: "7 日", inputs: "每日 TL、TM", evidence: "E6", version: "v1.0", valid: "TM 不可计算时 TS 亦不可计算", note: "与 TM 联动返回不可计算。" },
    "hrv.rmssd": { name: "RMSSD / lnRMSSD", short: "HRV", formula: "RMSSD = sqrt(mean(ΔRR²))；lnRMSSD = ln(RMSSD)", window: "日 / 7 / 28 日基线", inputs: "RR 间期、测量上下文", evidence: "E9 (Task Force 1996)", version: "v1.0", valid: "只在同一测量上下文（夜间/晨起）内比较", note: "不输出与厂商评分等价的黑盒分数。" },
    "sleep.tst": { name: "睡眠可解释维度", short: "TST / WASO / 效率", formula: "逐 epoch 腕动判别 sleep/wake → TST、WASO、效率、觉醒次数、规律性；或读取用户授权数据源", window: "夜", inputs: "腕动 / HealthKit", evidence: "E10 (Cole-Kripke / Sadeh)", version: "v1.0", valid: "分期精度有限；不输出医学结论", note: "本页不用于诊断。" },
    "vbt.mcv": { name: "MCV / MPV / PV", short: "VBT 速度", formula: "去重力 → 低通滤波 → 积分 → ZUPT → 重复切分；MCV 向心平均速度、MPV 推进阶段平均速度、PV 峰值速度", window: "每次重复", inputs: "IMU 三轴 acc+gyr 或手填速度", evidence: "E11", version: "v0.9（待真机标定）", valid: "滤波截止 / ZUPT 阈值未标定 → 不可计算", note: "不还原厂商传感器融合与标定实现。" },
    "vbt.vl": { name: "速度损失 VL%", short: "VL%", formula: "VL = (v_best − v_last) / v_best × 100", window: "每组", inputs: "重复速度序列", evidence: "E11", version: "v1.0", valid: "10/20/30% 仅作可配置阈值，不设为事实", note: "阈值在标定页调整并留版本。" },
    "vbt.lvp": { name: "负荷-速度剖面与 1RM 估计", short: "LVP / 1RM", formula: "V = a·kg + b（记录 R²）；1RM_est = (V1RM − b) / a", window: "一次测试", inputs: "多组负荷-速度对、V1RM 标定值", evidence: "E11", version: "v0.9", valid: "R² 低于配置门槛或 V1RM 未标定 → 不输出 1RM", note: "系数从配置读取，不硬编码猜测值。" },
    "vbt.power": { name: "VBT 功率", short: "功率", formula: "P = F·v，F = m(a + g)；等速近似 P ≈ m·g·v（须标注）", window: "每次重复", inputs: "速度、加速度、负荷", evidence: "E12", version: "v0.9", valid: "近似口径必须标注", note: "示例数据使用等速近似，标注于结果卡。" },
    "jump.height": { name: "跳跃高度", short: "跳跃高度", formula: "h = g·t_f² / 8，g = 9.81 m/s²；视频法 t_f = (frame_landing − frame_takeoff) / fps", window: "每次跳跃", inputs: "腾空时间或帧号 + fps", evidence: "E13 (Bosco 1983)", version: "v1.0", valid: "fps 缺失 → 视频法不可计算，不猜测帧率", note: "用例 1：t_f=0.500 s → 30.7 cm。" },
    "jump.rsi": { name: "RSI（反应力量指数）", short: "RSI", formula: "RSI = h / t_contact（DJ）；连续跳可用 t_f / t_contact 变体，口径需固定", window: "每次", inputs: "跳跃高度、接触时间", evidence: "E13", version: "v1.0", valid: "接触时间缺失 → 不可计算", note: "连续跳与 DJ 使用不同口径时分别标注。" },
    "jump.ppo": { name: "峰值功率与 FVP 剖面", short: "PPO / FVP", formula: "峰值功率按 Sayers 等（1999）经验式；力-速剖面按 Samozino 等方法", window: "每次", inputs: "体重、跳跃高度、推蹬距离", evidence: "E12 E13", version: "v0.8（配置未标定）", valid: "系数未从配置读取前不输出估算值", note: "本原型仅展示方法占位与口径，不输出未标定系数算出的数值。" }
  };

  const NAV = [
    { id: "today", label: "今日", icon: "today", children: [] },
    { id: "train", label: "训练", icon: "train", children: [
      { id: "calendar", label: "训练日历" }, { id: "session", label: "单次训练" },
      { id: "plan", label: "周期计划" }, { id: "library", label: "训练方案库" },
      { id: "goals", label: "比赛与目标" }
    ] },
    // B1：按「我要做什么」归组。VBT / 跳跃的结果页不再建同名导航项，
    // 只在「测量」保留采集入口；结果从分析页的卡片进入（analyze/vbt、analyze/jump）。
    { id: "analyze", label: "分析", icon: "analyze", children: [
      { id: "load", label: "负荷与周期" }, { id: "recovery", label: "恢复与睡眠" },
      { id: "endurance", label: "有氧与功率" }, { id: "report", label: "报告与导出" }
    ] },
    { id: "measure", label: "测量", icon: "lab", children: [
      { id: "vbt", label: "VBT 采集" }, { id: "jump", label: "跳跃采集" },
      { id: "sprint", label: "冲刺与变向" }, { id: "screen", label: "活动度与问卷" },
      { id: "history", label: "测试历史" }, { id: "calibration", label: "标定与动作库" }
    ] },
    { id: "data", label: "数据", icon: "data", children: [
      { id: "devices", label: "设备中心" }, { id: "sources", label: "数据源与授权" },
      { id: "import", label: "导入与手填" }, { id: "quality", label: "数据质量" },
      { id: "metrics", label: "指标口径 Registry" }, { id: "profile", label: "档案与设置" }
    ] }
  ];

  const ADMIN_NAV = [
    { id: "overview", label: "团队数据看板", icon: "chart" },
    { id: "athletes", label: "成员档案", icon: "users" },
    { id: "roles", label: "角色与权限", icon: "shield" },
    { id: "fleet", label: "设备与数据管理", icon: "database" },
    { id: "rules", label: "规则与口径版本", icon: "sliders" },
    { id: "audit", label: "审计日志", icon: "list" },
    { id: "compliance", label: "合规与备案", icon: "check" }
  ];

  const ROLES = [
    { id: "athlete", label: "运动员" }, { id: "coach", label: "教练" },
    { id: "head_coach", label: "主教练" }, { id: "medical", label: "队医 / 康复" },
    { id: "analyst", label: "科研 / 数据" }, { id: "admin", label: "管理员" },
    { id: "observer", label: "只读观察者" }
  ];

  // 展示用角色（上面 7 个）↔ 库内 RBAC 角色（app_role 枚举）的唯一映射。
  // 两边不是同一套命名：前端 head_coach / medical / admin 是界面用词，库内是
  // team_admin / clinician / org_admin。缺了这张表，「前端能点的按钮」和「服务端
  // 放不放行」就会错位。权限永远以库内角色为准，PERMISSIONS 只决定展示。
  //
  // 语义边界（与 0002 策略逐条对应）：
  //   head_coach → team_admin：可读写本队、可看组织成员与授权（memberships_select_managed），
  //                            但改角色要 org_admin（memberships_write）→ 即矩阵里的「受限」
  //   admin      → org_admin ：组织全权
  //   medical    → clinician ：可写运动员数据，不可改成员与角色
  const ROLE_MAP = {
    athlete: "athlete",
    coach: "coach",
    head_coach: "team_admin",
    medical: "clinician",
    analyst: "analyst",
    admin: "org_admin",
    observer: "observer"
  };

  // ● 完全 / ◐ 受限 / — 无（与 docs/01 §9.2 同源）
  const PERMISSIONS = {
    columns: ["athlete", "coach", "head_coach", "medical", "analyst", "admin", "observer"],
    rows: [
      { module: "今日 / 训练（本人）", v: ["full", "full", "full", "limited", "limited", "none", "none"], key: "today" },
      { module: "分析（成员级明细）", v: ["full", "full", "full", "limited", "full", "none", "none"], key: "analyze" },
      { module: "测量采集与录入", v: ["full", "full", "full", "limited", "none", "none", "none"], key: "measure" },
      { module: "设备配对 / 解绑（本人）", v: ["full", "limited", "limited", "none", "none", "none", "none"], key: "data" },
      { module: "设备群 / 批量导入", v: ["none", "none", "limited", "none", "none", "full", "none"], key: "fleet" },
      { module: "周期计划编辑 / 下发", v: ["none", "full", "full", "none", "none", "none", "none"], key: "plan" },
      { module: "团队数据看板", v: ["none", "full", "full", "limited", "full", "full", "limited"], key: "overview" },
      { module: "成员与邀请管理", v: ["none", "limited", "full", "none", "none", "full", "none"], key: "athletes" },
      { module: "角色与权限变更", v: ["none", "none", "limited", "none", "none", "full", "none"], key: "roles" },
      { module: "规则 / 口径版本与回滚", v: ["none", "none", "limited", "none", "limited", "full", "none"], key: "rules" },
      { module: "数据导出 / 删除请求", v: ["full", "limited", "full", "none", "full", "full", "none"], key: "export" },
      { module: "审计日志", v: ["none", "none", "limited", "none", "limited", "full", "none"], key: "audit" },
      { module: "合规与备案", v: ["none", "none", "none", "none", "none", "full", "none"], key: "compliance" }
    ]
  };

  const BOUNDARIES = [
    ["分析 ↔ 数据看板", "analyze/* 单运动员、长周期、可下钻到原始样本、可切换口径", "admin/overview 多运动员聚合、只读、最多下钻到成员页"],
    ["测试 ↔ 分析", "measure/* 采集与写入、实时反馈、设备/录入通道", "analyze/* 只读再计算与对比，不提供录入控件"],
    ["今日 ↔ 其余", "today 只给一个结论 + 三个入口", "其余页承载全部细节与图表"],
    ["数据（个人）↔ 管理（组织）", "data/* 本人设备、本人授权、本人缺测", "admin/fleet 设备资产、批量任务、凭据与保留策略"],
    ["Registry ↔ 分析", "data/metrics 是公式与版本唯一定义源", "分析页只引用，不重新定义公式"],
    ["弹层 ↔ 页面", "Sheet / Popover / Alert = 聚焦任务与第三层信息", "页面 = 可返回、可分享的持久位置"]
  ];

  const TEST_PROTOCOLS = [
    { group: "跳跃", items: ["CMJ", "SJ", "摆臂 CMJ", "DJ 跳深", "RSI 10-5", "立定跳远", "单腿不对称"] },
    { group: "VBT", items: ["杠铃速度", "负荷-速度剖面", "1RM 估计", "速度损失", "杠铃轨迹"] },
    { group: "冲刺 / 变向", items: ["5-0-5", "5+5", "V-Cut", "Illinois", "分段冲刺", "水平 FVP"] },
    { group: "筛查", items: ["踝背屈 ROM", "Nordic 断点角", "Wellness 问卷", "力-时间曲线"] }
  ];

  /* 训练模块专用：可选训练类型与可自行搭配的方案结构。
   * 这里只定义「结构」（类型 + 建议时长），不含任何成绩、负荷或历史数值；
   * 实际 RPE 与时长由用户填写，保存后才产生 TL。测试项目一律不在此列。 */
  const TRAIN_TYPES = [
    { id: "strength", label: "力量", hint: "抗阻 / 爆发力 / 器械" },
    { id: "run", label: "跑步", hint: "轻松跑 / 节奏 / 间歇" },
    { id: "bike", label: "骑行", hint: "耐力 / 阈值 / 功率" },
    { id: "swim", label: "游泳", hint: "技术 / 有氧" },
    { id: "ball", label: "球类", hint: "专项 / 对抗 / 技战术" },
    { id: "functional", label: "功能性 / 体能", hint: "循环 / 核心 / 移动" },
    { id: "recovery", label: "恢复 / 低强度", hint: "拉伸 / 低强度活动" },
    { id: "other", label: "其他", hint: "自行注明的训练" }
  ];

  /* 预设搭配方案：只是「段的组合建议」，不是已发生的训练记录。
   * seg = [训练类型 id, 建议分钟, 建议 RPE]，载入后可逐段修改或增删。 */
  const TRAIN_PRESETS = [
    { id: "p-strength", name: "力量主课", note: "热身 + 主训练 + 放松", seg: [["recovery", 10, 2], ["strength", 45, 7], ["recovery", 10, 2]] },
    { id: "p-endurance", name: "有氧耐力", note: "中低强度持续", seg: [["recovery", 10, 2], ["run", 50, 6], ["recovery", 10, 2]] },
    { id: "p-interval", name: "速度间歇", note: "高强度分段", seg: [["recovery", 15, 3], ["run", 30, 8], ["recovery", 10, 2]] },
    { id: "p-threshold", name: "骑行阈值", note: "稳态阈值", seg: [["recovery", 10, 2], ["bike", 60, 7], ["recovery", 10, 2]] },
    { id: "p-recovery", name: "恢复日", note: "只安排低强度", seg: [["recovery", 30, 2]] },
    { id: "p-mixed", name: "综合体能", note: "体能 + 专项混合", seg: [["recovery", 10, 3], ["functional", 25, 6], ["ball", 25, 6], ["recovery", 10, 2]] },
    { id: "p-swim", name: "游泳技术", note: "技术为主", seg: [["recovery", 10, 2], ["swim", 45, 5], ["recovery", 5, 2]] },
    { id: "p-prematch", name: "赛前激活", note: "短时高质量", seg: [["recovery", 15, 3], ["ball", 20, 8], ["recovery", 10, 2]] }
  ];

  window.ARC = {
    DATES, DATES_FULL, TL_BASE, RMSSD_BASE, SLEEP, VBT_SETS, JUMPS, DEVICES,
    SOURCES, SESSIONS, PLAN_BLOCKS, ATHLETES, AUDIT, RULES, METRICS, NAV,
    ADMIN_NAV, ROLES, ROLE_MAP, PERMISSIONS, BOUNDARIES, TEST_PROTOCOLS,
    TRAIN_TYPES, TRAIN_PRESETS,
    G: 9.81
  };
})();
