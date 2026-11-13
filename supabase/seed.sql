-- ============================================================================
-- 第三世界 · 指标口径种子
-- 仅为 metric_registry 参考数据，不含任何运动员数据（不造真实数据）。
-- core        = ARC 自有可解释口径，参与训练建议生成
-- vendor_aligned = 对标展示占位（名称/刻度/分档来自公开资料），**不参与决策**，
--                  且在 UI 必须带 DEMO 标记（docs/04 §3、§5）
-- ============================================================================

insert into public.metric_registry (metric_id, label, unit, category, formula, calc_version, tier, is_sensitive, notes) values
  -- 负荷与周期
  ('ctl',            '慢性负荷 CTL',    'AU',  'load', 'CTL_t = CTL_{t-1} + (TL_t - CTL_{t-1}) / 42', 'v1.0', 'core', false, '42 日指数加权'),
  ('atl',            '急性负荷 ATL',    'AU',  'load', 'ATL_t = ATL_{t-1} + (TL_t - ATL_{t-1}) / 7',  'v1.0', 'core', false, '7 日指数加权'),
  ('tsb',            '负荷平衡 TSB',    'AU',  'load', 'TSB_t = CTL_{t-1} - ATL_{t-1}',                'v1.0', 'core', false, '训练前状态，非当日差值'),
  ('acwr.rolling',   'ACWR（滚动）',    'ratio','load','ACWR = TL_7d / (TL_28d / 4)',                  'v1.0', 'core', false, '急性窗含于慢性窗，存在数学耦合'),
  ('acwr.ewma',      'ACWR（EWMA）',    'ratio','load','ACWR = EWMA_7(TL) / EWMA_28(TL)',               'v1.0', 'core', false, '主口径'),
  ('tl.tss',         '训练负荷 TSS',    'AU',  'load', 'TSS = (sec × NP × IF) / (FTP × 3600) × 100',   'v1.0', 'core', false, '需功率或配速阈值'),
  ('tl.srpe',        '训练负荷 sRPE',   'AU',  'load', 'sRPE = RPE × duration_min',                    'v1.0', 'core', false, 'RPE 缺失时不可计算'),
  ('tm',             '训练单调性 TM',   'ratio','load','TM = mean(TL_7d) / sd(TL_7d)',                 'v1.0', 'core', false, '周内标准差为 0 时不可计算'),
  ('ts',             '训练应变 TS',     'AU',  'load', 'TS = TL_7d_total × TM',                        'v1.0', 'core', false, '依赖 TM，TM 不可算则 TS 不可算'),
  -- 恢复与睡眠
  ('hrv.rmssd',      'HRV · RMSSD',     'ms',  'recovery', 'RMSSD = sqrt(mean(ΔRR²))',                 'v1.0', 'core', true,  '敏感：健康数据'),
  ('hrv.lnrmssd',    'HRV · lnRMSSD',   'ln(ms)','recovery','lnRMSSD = ln(RMSSD)',                     'v1.0', 'core', true,  '敏感：健康数据'),
  ('sleep.tst',      '总睡眠时长 TST',  'min', 'recovery', 'TST = Σ 睡眠期时长',                       'v1.0', 'core', true,  '敏感：健康数据'),
  ('sleep.efficiency','睡眠效率',       '%',   'recovery', 'SE = TST / TIB × 100',                     'v1.0', 'core', true,  'TIB = 卧床总时长'),
  -- 跳跃
  ('jump.height',    '跳跃高度（飞行时间法）','cm','jump','h = g · t_f² / 8',                         'v1.0', 'core', false, 't_f 为飞行时间；视频法需 fps，缺则不可计算'),
  ('jump.contact_time','触地时间',      'ms',  'jump', '-',                                                 'v1.0', 'core', false, '需测力台或高速摄像'),
  ('jump.rsi',       '反应力量指数 RSI','m/s', 'jump', 'RSI = h / t_c',                                   'v1.0', 'core', false, 't_c 为触地时间（秒）'),
  ('jump.ppo',       '峰值功率 PPO',    'W',   'jump', 'PPO = 60.7 × h + 45.3 × BM − 2055',               'v1.0', 'core', false, 'Sayers 方程，需体重'),
  -- VBT
  ('vbt.mcv',        '平均向心速度 MCV', 'm/s', 'vbt', 'MCV = Δ位移 / 向心时长',                        'v1.0', 'core', false, 'IMU 积分 + ZUPT 修正'),
  ('vbt.vl',         '速度损失 VL',      '%',   'vbt', 'VL = (MCV_best − MCV_last) / MCV_best × 100',   'v1.0', 'core', false, '组内首末次比较'),
  ('vbt.lvp',        '负荷-速度剖面 R²', '-',   'vbt', '线性回归 load ~ MCV 的 R²',                     'v1.0', 'core', false, '标定点不足时不可计算'),
  ('vbt.1rm',        '估算 1RM',         'kg',  'vbt', '由 LVP 回归外推至最小速度阈值',                  'v1.0', 'core', false, '未标定时返回不可计算，不猜测'),
  ('vbt.power',      '输出功率',         'W',   'vbt', 'P = F · v（含质量与加速度修正）',                'v1.0', 'core', false, 'IMU 加速度积分'),
  -- 对标展示占位（不参与决策）
  ('evlab.status',   'EvoLab 训练状态',  '-',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值，非厂商算法'),
  ('evlab.recovery', 'EvoLab 恢复计时',  'h',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值'),
  ('evlab.running',  'EvoLab 跑步表现',  '-',   'vendor', '-', 'v1.0', 'vendor_aligned', false, '公开分档占位；DEMO 值'),
  ('te.aerobic',     'Training Effect 有氧', '-','vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('te.anaerobic',   'Training Effect 无氧', '-','vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('sleep.score',    '睡眠评分',         '-',   'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('hrv.status',     'HRV 状态',         '-',   'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值'),
  ('coros.hrv',      '夜间 HRV 均值',    'ms',  'vendor', '-', 'v1.0', 'vendor_aligned', true,  '公开分档占位；DEMO 值')
on conflict (metric_id) do nothing;
