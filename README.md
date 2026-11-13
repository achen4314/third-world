# 第三世界 · 综合运动训练软件原型

面向 **iPhone / iPad / Mac** 的可点按高保真原型 + 可直接进入开发的规格文档。目标是把「设备 → 原始样本 → 派生指标 → 负荷/周期 → 决策」组织成一条可下钻、可解释、可审计的链路，避免把所有功能堆叠在单一界面。

## 快速开始

```bash
# 1) 起本地服务（不要用 file:// 打开，浏览器会对跨域请求做限制）
npm run serve            # http://127.0.0.1:8799

# 2) 填 publishable key（唯一的必填项）
#    Dashboard → Project Settings → API Keys → Publishable key → Copy
#    写进 prototype/env.js 的 SUPABASE_PUBLISHABLE_KEY，或在页面「数据源」里粘一次
```

没有 key 时页面以**演示数据**运行（可点、可演示，数值不可信，界面有标记）；
填了 key 就从「演示数据」切换为「真实数据」，注册 / 登录 / 记录训练 / 团队管理全部可用。

演示账号（已在真实库建好，登录后可改密码）：`demo@third.world` / `ArcDemo2026!`

### 自测命令

```bash
npm run db:audit      # 数据库与权限体系 28 项
npm run test:flows    # 业务流程 38 项（事务内，跑完回滚）
npm run test:api      # API 端到端（需要 publishable key）
npm run mock:api      # 本地假后端，用于在没有 key 时验证前端链路
```

```
也可以直接用浏览器打开 prototype/index.html（仅限演示模式）
```

零依赖、零构建、无需服务器；也可在 iPhone / iPad / Mac 浏览器打开同一文件。建议在预览面板中先切到 **Mac** 看全貌，再切 **iPad / iPhone** 验证跨端一致性。

控制台（产品界面之外的灰色栏）：

| 控件 | 作用 |
|---|---|
| `iPhone / iPad / Mac` | 切换 size class：Tab Bar ↔ Sidebar、1 / 2 / 3 列、Sheet 形态 |
| 角色下拉 | 切换 7 类 RBAC 角色，观察可见模块与锁定态 |
| 圆形按钮 | 浅色 / 深色切换 |

也支持深链，便于评审与截图定位：

```
index.html?platform=iphone&route=analyze/load&theme=dark&role=observer&window=7&source=device&status=loading&live=0
```

`window` / `source` / `status` / `live` 用于定位实时图表的筛选与状态（`ok` / `loading` / `empty` / `error` / `offline`）。

产品界面内：

- 顶栏 **工作台**：进入教练后台（独立工作区，清空导航栈）
- 顶栏 **⌘K**：命令面板，跨层级直达任意页面或弹层（`Ctrl+K` 亦可）
- 任意指标卡的 **ⓘ 口径** 芯片：下钻到公式、版本、窗口、输入、证据编号与原始样本
- 顶栏 **28 日 · EWMA**：切换窗口 / TL 口径 / ACWR 口径 / HRV 上下文
- 顶栏 **实时 · 1 Hz / ↻ / 对标评分**：暂停推流、即时刷新、打开对标评分与阈值全表
- 页面上的 **实时控制条**：窗口 / 来源 / 状态演示筛选、悬停十字线详情、即时刷新、融合与评分入口

## 六个值得现场验证的交互

| # | 操作 | 期望 |
|---|---|---|
| 1 | `分析 → 负荷与周期` → 「注入缺测（演示）」 | 7 日有效天 5/7，**TM / TS / ACWR rolling 立刻变「—」并给出原因**，不补 0、不估算 |
| 2 | `测试 → 标定与动作库` → 「写入标定值（演示）」 → `分析 → VBT 分析` | 1RM 从「—（V1RM 未标定）」变为真实计算值；散点图出现 1RM 虚线 |
| 3 | `数据 → 导入与手填` → 「手动填入」，把 `t_f` 改成 `0.500` | 按 `h = g·t_f²/8` **实时算出 30.66 cm**；清空 `fps` 时提示视频法不可计算，不猜测帧率 |
| 4 | 任一含图表页 → 鼠标移过图表 / 键盘 ← → | 十字线吸附到最近点，浮层显示日期、各序列值、口径 / 窗口 / 来源 / `quality_flag` / version / DEMO |
| 5 | 实时控制条依次点 `7 日`、`manual`、`加载中 / 空数据 / 异常 / 离线`、`即时刷新` | 窗口真实截断、非匹配来源变「—」空位、五种反馈覆盖层、刷新后**全部卡片同步切到同一 version** |
| 6 | 顶栏「对标评分」或 `分析 → 恢复与睡眠` 的评分卡 | 8 个评分的完整分档表、状态含义、依据等级、公开资料差异标注；全部 DEMO 且声明不还原真实算法 |

另有：设备配对分步 Sheet、IMU CSV/JSON 字段映射 Sheet、新建测试协议网格、规则解释 Sheet、数据融合与字段映射 Sheet（O13）、关键操作二次确认、缺测热力日历点按补录、权限矩阵与角色切换。

## 交付物

| 文件 | 内容 |
|---|---|
| `prototype/index.html` | 原型入口（三端设备框架 + 控制台） |
| `prototype/styles.css` | HIG 设计令牌、三端布局、组件、弹簧动效、四套系统偏好 media query |
| `prototype/data.js` | DEMO 数据、设备/数据源、角色权限矩阵、模块边界、`metric-registry` |
| `prototype/live.js` | 实时单一快照引擎（SSE 仿真 1 Hz）、悬停 / 筛选 / 即时刷新、五态反馈、8 个对标评分、融合数据与字段映射、O12 / O13 |
| `prototype/app.js` | 计算引擎（真实公式）、SVG 图表、36 条路由、13 类浮层、RBAC、命令面板、实时能力注入 |
| `docs/01-产品功能结构与信息架构.md` | 10 个功能域、竞品能力覆盖对照、一级/二级页面、浮层、边界表、26 条跳转逻辑、权限矩阵、数据看板边界 |
| `docs/02-交互流程与视觉设计规则.md` | 字体/颜色/间距/材质令牌、三端适配表、组件库、动效参数、6 条交互流程、无障碍清单 |
| `docs/03-技术架构与开发交接.md` | 技术选型决策、feature-first 目录、数据模型、指标口径表、REST 端点、配置、P0–P8、验证用例、上架合规 |
| `docs/04-实时交互图表可行性与对标口径评估.md` | **36 个界面 + 13 类浮层逐一可行性评估**、实时图表能力矩阵与状态一致性、8 个专有评分的完整分档与依据等级、数据融合与字段映射、DEMO 与免责声明 |
| `docs/05-上线前资源对照与逐项核查报告.md` | 12 类数据库/资源的权限配置对照（三状态）、五节点接入提醒清单、76 项逐项核查报告、上线结论与剩余风险 |
| `tools/audit.mjs` | 可复现的 CDP 运行时断言脚本（76 项：算法 / 图表 / 交互 / 边界 / 路由） |
| `supabase/migrations/*.sql` | **数据库唯一事实源**：17 张表 + 37 条 RLS 策略 + 4 个鉴权函数 |
| `supabase/seed.sql` | 30 条指标口径（22 core + 8 vendor_aligned 隔离） |
| `supabase/README.md` | Supabase 三种连法、RLS 模型、越权测试、验证状态 |
| `tools/db-check.cjs` | 可复现的数据库断言脚本（18 项：迁移 / 策略 / 4 类越权 / 缺测不补 0） |
| **`supabase/apply-all.sql`** | **一次性建库脚本**：0001 + 0002 + seed + 11 项自检，SQL Editor 整段粘贴即可 |
| `supabase/reset.sql` | 清库脚本（破坏性，带 `set app.allow_drop` 硬保护，默认拒绝执行） |
| `.env.example` | 环境变量模板（占位值，键名对应 docs/06 C1–C11） |
| `tools/check-env.mjs` | 环境校验 + 连通性自检（`--probe` 可判断迁移是否已推送） |
| **`tools/apply-remote.mjs`** | **远程建库**：读 `.env.local` 连接串 → 预检空库 → 执行 apply-all → 远程自检；`--verify-only` 只自检；`--dry-run` 只校验 |
| `package.json` / `package-lock.json` | `npm run db:apply` / `db:verify` / `check:db` / `check:env` |

## 仓库与 Supabase 接入

- GitHub：<https://github.com/achen4314/third-world>（公开）
- Supabase **只认 `supabase/migrations/`**，不会因为仓库连上 GitHub 就获得表结构。
- **当前状态**：库已建好（2026-11-14）—— 17 张业务表 + 37 条 RLS 策略 + 30 条指标口径，自检 11/11 ✓，RLS 已在真实库验证。

三种建库方式，任选：

```bash
# A. 一条命令（需 .env.local 里填 DATABASE_URL，走 Session pooler 5432）
npm install
npm run db:apply          # 建库 + 自检
npm run db:verify         # 只自检，可反复跑

# B. SQL Editor 手工粘贴：supabase/apply-all.sql 整段执行

# C. Supabase CLI
brew install supabase/tap/supabase && supabase login
supabase link --project-ref bffuuxdnztowlwbxjlzp && supabase db push
```

离线可复现验证（不连云）：

```bash
npm i -D @electric-sql/pglite && node tools/db-check.cjs
```

> ⚠️ 直连域名 `db.<ref>.supabase.co` **只有 IPv6**；本机 DNS 走代理 fake-ip 时无法解析，请用 `aws-1-<region>.pooler.supabase.com:5432`（会话池化，可执行 DDL）。**不要**用 6543 事务池化跑建表。

## 在线预览（初始版本已上线）

**分享链接**：https://wbapp-k0bet8c6zs2h30k34xnsuk.app.workbuddy.host/?sharecode=RE4LW7PFAF

静态 DEMO 原型预览版，仅供内部评审；不是含账号权限的生产系统，不得录入真实健康数据。**前往「设置—数据管理—应用」中管理**。详情见 `docs/05` §4。

## 关键决策（可一行改）

| 项 | 选择 |
|---|---|
| 目标工程 | SwiftUI 多平台单 Target（iOS/iPadOS/macOS）+ Node/Fastify + PostgreSQL/TimescaleDB + Redis |
| 原型 | 零构建 HTML/CSS/JS，`ARC.adapter` 可替换为真实 API 客户端 |
| 架构 | feature-first；Controller → Service → Repository；计算层为纯函数 + 显式口径版本 |
| 接口 | REST + OpenAPI 3.1 → 生成类型化客户端；SSE 单向实时流；独立 worker 跑导入与聚合 |
| 认证 | JWT 15min + 服务端刷新令牌（httpOnly Cookie）+ RBAC；令牌不进 localStorage / URL |
| 主线 | 负荷 → 恢复 → 表现；每页只回答一个问题；导航最多两层，第三层一律 Sheet |

## 已完成的验证（2026-11-13）

- `node --check`：data.js / live.js / app.js 语法通过。
- 无头 Chrome 实渲染：Mac / iPad / iPhone 三档 + 浅色 / 深色 + 教练工作台 + 实时控制条 + 对标评分弹层，截图确认无重叠、无裁切、图表可见。
- CDP 运行时自检：**36 条路由全部渲染成功、0 个失败、0 个 JS 异常**；SVG 图表挂载 2/页；指标下钻 Sheet、缺测注入、手动填入实时公式（t_f=0.500 → 30.66 cm）、V1RM 标定 → 1RM 127.2 kg、Observer 锁定态、命令面板 ⌘K 过滤、口径切换、深链、主题切换均通过。
- v1.1 追加自检：实时控制条渲染、8 个对标评分（36 行分档 + 7 行还原边界）/ 5 张融合表、悬停详情浮层、窗口筛选（28 → 7 日，labels=7）、来源筛选（manual → 6 个「—」空位）、五种状态覆盖层、即时刷新（loading → ok，version+2）、1 Hz 推流、O12 / O13 弹层全部通过。
- **v1.2 上线前核查**：`tools/audit.mjs` 76 项断言 **76 通过 / 0 异常**；修复 4 项真实缺陷（O6 窗口未同步实时引擎、实时条窗口未回写芯片与弹层、热力日历补录日期未带入表单、TL 口径仅改标签未标注限制），并专项复验通过；`scan-targets` 0 个原生端、明文密钥 0 命中；线上分享链接已用真实浏览器复验今日页与 `analyze/load` 页完整渲染、无 JS 异常。详见 `docs/05`。

## 口径与边界（重申）

- **`AWCR` 一律按 `ACWR` 处理**（本次确认，不再列为待确认项），Registry 中仅作别名登记，同时提供 rolling 与 EWMA 双口径；`TL / TM / TS` = Training Load / Monotony / Strain。若后续给出不同定义，新增 `metric_id` 而不改写既有口径。
- 按功能域覆盖 COROS / Garmin / My Jump Lab / Enode Pro 的公开能力范围。**按本次确认口径**，专有评分的**公开显示语义**（名称 / 刻度 / 阈值分档 / 状态含义）与数据融合的**来源 / 字段映射 / 内部实现要点**做**原型级对标占位还原**（详见 `docs/04`）；但**不实现也不宣称还原** EPOC / Firstbeat / 自适应基线等真实算法，不复制界面资产，不还原厂商传感器融合与标定实现，不输出医学结论。ARC 决策层仍为可解释规则。
- 数据治理：每条样本带 `source` 与 `quality_flag`；**缺测显示「—」，不插值、不补零、不估算、不合并**；同指标多来源筛选时互斥。
- 原型全部数值为 **DEMO 演示样例**，不是真实运动数据，不构成训练或医学建议；其中 CTL/ATL/TSB、ACWR 双口径、TM/TS、跳跃高度、RSI、速度损失、LVP 回归与 1RM 均由原型内公式**实际计算**得出。
- 本交付为按公开标准与文献的独立设计，不含任何闭源程序逆向结果；厂商云端 API 与 FIT SDK 需自行申请授权。
