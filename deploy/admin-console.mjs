#!/usr/bin/env node
/* 第三世界 · 后台管理控制台（服务端）
 *
 * 设计原则（这台机器上还跑着 Dify，不能出岔子）：
 *   1. 只监听 127.0.0.1，由 nginx 反向代理暴露，不直接对公网开端口。
 *   2. 必须设置 ARC_ADMIN_TOKEN 才启动；没 token 直接退出，不留无密码后台。
 *   3. 所有维护动作是「白名单里挑一个固定命令」，绝不接收客户端传来的命令字符串。
 *   4. 配置文件 0600；GET /api/config 返回的 key 一律掩码，不回显完整密钥。
 *   5. 改配置只重写 prototype/env.js，不碰数据库、不碰 Dify 的 nginx server 块。
 *
 * 用法：
 *   ARC_ADMIN_TOKEN='...' ARC_ADMIN_ROOT='/opt/arc-training' node deploy/admin-console.mjs
 * 环境变量：
 *   ARC_ADMIN_BIND   默认 127.0.0.1
 *   ARC_ADMIN_PORT   默认 8787
 *   ARC_ADMIN_ROOT   项目根目录（默认本文件上一级）
 *   ARC_ADMIN_CONFIG 配置文件路径（默认 <root>/deploy/runtime/config.json）
 *   ARC_DOMAIN       用于状态页 DNS 检查的域名
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ARC_ADMIN_ROOT || path.resolve(HERE, "..");
const CONFIG = process.env.ARC_ADMIN_CONFIG || path.join(HERE, "runtime", "config.json");
const TOKEN = process.env.ARC_ADMIN_TOKEN || "";
const BIND = process.env.ARC_ADMIN_BIND || "127.0.0.1";
const PORT = Number(process.env.ARC_ADMIN_PORT || 8787);
const DOMAIN = process.env.ARC_DOMAIN || "trthirdworld.online";

if (!TOKEN) {
  console.error("✗ 未设置 ARC_ADMIN_TOKEN：拒绝启动一个没有口令的管理后台。");
  process.exit(2);
}
if (BIND !== "127.0.0.1" && BIND !== "::1" && BIND !== "localhost") {
  console.error("✗ 出于安全考虑只允许绑定回环地址；公网入口请走 nginx 反代 + HTTPS。");
  process.exit(2);
}

const DEFAULT_CONFIG = {
  supabaseUrl: "https://bffuuxdnztowlwbxjlzp.supabase.co",
  publishableKey: "",
  domain: DOMAIN,
  allowRuntimeKey: false,
  note: ""
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(CONFIG, 0o600); } catch { /* noop */ }
}
function mask(k) {
  if (!k) return "";
  return k.length <= 12 ? k.slice(0, 2) + "…" : k.slice(0, 14) + "…" + k.slice(-4);
}
function publicConfig(c) {
  return { ...c, publishableKey: mask(c.publishableKey), hasKey: !!c.publishableKey };
}

function writeEnv(c) {
  const out = "/* 由后台控制台生成 · " + new Date().toISOString() + " */\n" +
    "window.ARC_ENV = {\n" +
    "  SUPABASE_URL: " + JSON.stringify(String(c.supabaseUrl || "").replace(/\/+$/, "")) + ",\n" +
    "  SUPABASE_PUBLISHABLE_KEY: " + JSON.stringify(c.publishableKey || "") + ",\n" +
    "  ALLOW_RUNTIME_KEY: " + (c.allowRuntimeKey === true ? "true" : "false") + "\n" +
    "};\n";
  const target = path.join(ROOT, "prototype", "env.js");
  fs.writeFileSync(target, out, "utf8");
  return target;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

async function probe(label, fn) {
  const t0 = Date.now();
  try { return { label, ok: true, value: await fn(), ms: Date.now() - t0 }; }
  catch (e) { return { label, ok: false, value: String(e && e.message || e).slice(0, 160), ms: Date.now() - t0 }; }
}

async function status() {
  const c = readConfig();
  const checks = [
    probe("主机", async () => ({ hostname: os.hostname(), uptimeMin: Math.round(os.uptime() / 60), load: os.loadavg().map(x => +x.toFixed(2)), memFreeMB: Math.round(os.freemem() / 1048576), memTotalMB: Math.round(os.totalmem() / 1048576) })),
    probe("磁盘", async () => {
      const { stdout } = await run("df", ["-Pk", ROOT], { timeout: 5000 });
      const l = stdout.trim().split("\n").pop().split(/\s+/);
      return { totalGB: +(l[1] / 1048576).toFixed(2), usedGB: +(l[2] / 1048576).toFixed(2), usedPct: l[4] };
    }),
    probe("nginx 配置", async () => (await run("nginx", ["-t"], { timeout: 5000 })).stderr.trim().split("\n").pop() || "ok"),
    probe("应用服务", async () => (await run("systemctl", ["is-active", "arc-admin"], { timeout: 5000 })).stdout.trim()),
    probe("nginx 服务", async () => (await run("systemctl", ["is-active", "nginx"], { timeout: 5000 })).stdout.trim()),
    probe("域名解析 " + c.domain, async () => ({ a: await dns.resolve4(c.domain).catch(() => []) })),
    probe("Supabase Auth", async () => {
      const r = await fetch(String(c.supabaseUrl).replace(/\/+$/, "") + "/auth/v1/settings", {
        headers: { apikey: c.publishableKey || "invalid" }, signal: AbortSignal.timeout(6000)
      });
      return { http: r.status };
    })
  ];
  return { time: new Date().toISOString(), config: publicConfig(c), checks: await Promise.all(checks) };
}

const ACTIONS = {
  "healthcheck": ["systemctl", ["is-active", "arc-admin", "nginx"]],
  "reload-nginx": ["systemctl", ["reload", "nginx"]],
  "restart-app": ["systemctl", ["restart", "arc-admin"]],
  "nginx-test": ["nginx", ["-t"]],
  "tail-logs": ["journalctl", ["-u", "arc-admin", "-n", "60", "--no-pager"]]
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;

  // 静态页（登录表单本身不需要 token）
  if (p === "/" || p === "/index.html" || p === "/admin" || p === "/admin/") {
    try {
      const html = fs.readFileSync(path.join(HERE, "admin", "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (e) { return json(res, 500, { error: "管理页文件缺失：" + e.message }); }
  }
  if (!p.startsWith("/api/")) return json(res, 404, { error: "not found" });

  const auth = String(req.headers.authorization || "");
  if (auth !== "Bearer " + TOKEN) return json(res, 401, { error: "口令不正确或未登录" });

  if (req.method === "GET" && p === "/api/status") return json(res, 200, await status());
  if (req.method === "GET" && p === "/api/config") return json(res, 200, publicConfig(readConfig()));

  if (req.method === "POST" && (p === "/api/config" || p === "/api/action")) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) return json(res, 413, { error: "请求体过大" });
    }
    let input = {};
    try { input = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "JSON 格式错误" }); }

    if (p === "/api/config") {
      const cur = readConfig();
      const next = {
        supabaseUrl: typeof input.supabaseUrl === "string" ? input.supabaseUrl.trim().replace(/\/+$/, "") : cur.supabaseUrl,
        publishableKey: typeof input.publishableKey === "string" && input.publishableKey && !input.publishableKey.includes("…")
          ? input.publishableKey.trim() : cur.publishableKey,
        domain: typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : cur.domain,
        allowRuntimeKey: input.allowRuntimeKey === true,
        note: typeof input.note === "string" ? input.note.slice(0, 500) : cur.note
      };
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(next.supabaseUrl))
        return json(res, 400, { error: "SUPABASE_URL 必须是 https://<ref>.supabase.co" });
      if (next.publishableKey && !/^sb_publishable_/.test(next.publishableKey))
        return json(res, 400, { error: "只接受 sb_publishable_ 开头的 key；service_role / secret key 绝不能放前端" });
      writeConfig(next);
      let envPath = null;
      try { envPath = writeEnv(next); } catch (e) { return json(res, 500, { error: "写入 env.js 失败：" + e.message }); }
      return json(res, 200, { ok: true, config: publicConfig(next), envPath });
    }

    const act = ACTIONS[String(input.name || "")];
    if (!act) return json(res, 400, { error: "不支持的动作；只接受白名单内的固定命令" });
    try {
      const r = await run(act[0], act[1], { timeout: 15000 });
      return json(res, 200, { ok: true, name: input.name, stdout: String(r.stdout || "").slice(0, 6000), stderr: String(r.stderr || "").slice(0, 2000) });
    } catch (e) {
      return json(res, 200, { ok: false, name: input.name, stdout: String(e.stdout || "").slice(0, 2000), error: String(e.message || e).slice(0, 300) });
    }
  }
  return json(res, 405, { error: "method not allowed" });
});

server.listen(PORT, BIND, () => {
  console.log(`后台管理控制台已启动：http://${BIND}:${PORT}  （仅回环，由 nginx 反代）`);
  console.log(`项目根目录：${ROOT}`);
  console.log(`配置文件：${CONFIG}`);
});
