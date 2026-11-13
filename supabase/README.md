# Supabase 接入说明

> 这个目录是**唯一**能让 Supabase 真正「读取」本仓库的部分。
> Supabase 不会因为仓库连上 GitHub 就获得你的表结构 —— 它只认 `supabase/migrations/` 里的 SQL。

## 1. 目录内容

| 文件 | 作用 |
|---|---|
| `config.toml` | CLI 本地配置（占位值，无密钥） |
| `migrations/20261114000001_init.sql` | 17 张表：组织 / 用户 / 队伍 / 运动员 / 设备 / 凭据 / 训练 / 采样 / 指标 / 测试 / 同意 / 审计 |
| `migrations/20261114000002_rls.sql` | 4 个鉴权函数 + 全部 RLS 策略 |
| `seed.sql` | 30 条指标口径（22 core + 8 vendor_aligned） |

## 2. 三种连法，按你的目标选

### A. CLI 直推（最常用，免费版可用）

```bash
# 一次性：安装 CLI（macOS）
brew install supabase/tap/supabase

# 登录（浏览器授权，不产生明文密码）
supabase login

# 关联到你的云项目
supabase link --project-ref <你的 project-ref>

# 推迁移（会依次执行 migrations/*.sql）
supabase db push

# 只推种子口径表
psql "$DATABASE_URL" -f supabase/seed.sql
```

`project-ref` 在 Supabase 控制台 → Project Settings → General → Reference ID。

### B. GitHub Integration（Supabase 分支功能）

- 控制台 → Project Settings → Integrations → GitHub，选择本仓库。
- 效果：打开 PR 时自动创建 preview branch 并**重放 migrations**；合并到主分支不影响生产库。
- 限制：**需要 Pro 计划**（$25/mo 起）；免费版无此功能。
- 关键前提：仓库里必须有 `supabase/migrations/`（现在有了）。

### C. 手动在 SQL Editor 粘贴

按文件名顺序执行两个 `.sql`，再执行 `seed.sql`。适合临时验证，不适合长期维护。

## 3. RLS 模型（与 `docs/01` 的 RBAC 矩阵对应）

```
auth.uid()  ──► memberships(role, org_id, team_id, expires_at)
                     │
                     ├─ org 级授权（team_id IS NULL）→ 全组织可见
                     └─ team 级授权（team_id 非空）  → 仅该队可见
                              │
athlete_grants ───────────────┴─► 单人只读授权（队医/临时协作）

can_read_athlete(athlete_id)  = 本人 ∪ 同组织且同队 ∪ 单人授权
can_write_athlete(athlete_id) = 本人 ∪ coach / team_admin / org_admin / clinician（同范围）
```

三条硬规则：

1. **`device_credentials` 没有任何策略** → RLS 开启后 anon / authenticated 一律拒绝，只有 `service_role` 能读写。厂商 OAuth 令牌不会漏到前端。
2. **`audit_logs` 只追加** → 已 `revoke update, delete`，写入强制 `actor_id = auth.uid()`。
3. **`daily_metrics.value` 允许 NULL** → 缺测写 NULL + `quality='missing'`，**不补 0、不插值**，与原型「不估算」原则一致。

## 4. 越权测试（推完后必须跑一遍，4 条）

| # | 场景 | 期望 |
|---|---|---|
| 1 | A 组织用户查询 B 组织运动员 | 返回 0 行（不是报错） |
| 2 | A 队教练写入 B 队运动员的训练记录 | 被 RLS 拒绝（`new row violates row-level security policy`） |
| 3 | `observer` 角色尝试 insert `activities` | 被拒绝 |
| 4 | 任何 authenticated 用户读 `device_credentials` | 返回 0 行（默认拒绝生效） |

> 注意：RLS 拦截表现为「查不到 / 写入报策略错误」，**不会**返回 403。这是 Postgres 语义，不是缺陷。

## 5. 我还没有的东西（推之前请确认）

| 项 | 状态 | 影响 |
|---|---|---|
| `project-ref` | 待你提供 | 无法 `supabase link` |
| 套餐（免费 / Pro） | 待确认 | 免费版无分支功能、无备份、无 PITR |
| 连接串（`DATABASE_URL` / `DIRECT_URL`） | 待提供，走 `.env` | 无法从本机直连与推种子 |
| Storage 策略 | **未写** | 视频 / FIT 文件桶需按 `athlete_id` 前缀单独建策略 |
| Realtime publication | **未开** | 若走 Supabase Realtime 推送，需 `alter publication supabase_realtime add table ...` |
| Edge Functions | **未写** | 导出、删除、OAuth 回调等异步任务尚未落地 |

## 6. 验证状态（已在真 Postgres 上实跑）

本机没有 psql / Docker / Supabase CLI，因此用 **PGlite（PostgreSQL 18.6，WASM）** 模拟 Supabase 预置环境后实跑：

```
PASS  harness: Supabase 预置环境（auth.users / auth.uid() / anon / authenticated / service_role）
PASS  迁移执行: 20261114000001_init.sql
PASS  迁移执行: 20261114000002_rls.sql
PASS  迁移执行: seed.sql
PASS  表数量 18（17 张 + 分区父表）
PASS  RLS 策略 37 条
PASS  指标口径 30 条 / vendor_aligned 8 条隔离
PASS  用例1 跨组织+跨队隔离  — 仅可见 运动员A1（A2/B1 均被隔离）
PASS  用例1b 跨队不可见
PASS  用例2 跨组织写入被拒  — new row violates row-level security policy
PASS  用例3 observer 写入被拒
PASS  用例4 令牌表默认拒绝  — 即便 org_admin 也只读到 0 行
PASS  本人自读 / 缺测以 NULL 存储 / audit_logs 禁改 / 分区表写入
合计 18 项：PASS 18 / FAIL 0
```

复现：

```bash
npm i -D @electric-sql/pglite
node tools/db-check.cjs
```

**仍未验证（不要当成已验证）**：

| 项 | 说明 |
|---|---|
| Supabase 托管环境差异 | PGlite 是原生 PG 18，Supabase 为 PG 15；`auth` schema、`storage`、RLS 语义一致，但扩展与角色细节需实机确认 |
| `pgcrypto` 扩展 | 测试时被剥离（`gen_random_uuid()` 在 PG13+ 已内置）；托管环境有 pgcrypto，不冲突 |
| Storage 策略 | 未写。`videos` / `imports` / `exports` 三个桶需按 `athlete_id` 前缀单独建策略 |
| Realtime / Edge Functions | 未配置。SSE 推流与导出、删除、OAuth 回调等异步任务尚未落地 |
| 首次 `db push` 后 | 仍须在托管库上重跑第 4 节的 4 条越权用例；报错原文给我，我按报错改 |

---

所有 DEMO 数值与口径仅用于原型验证，**不构成训练或医学建议**。
