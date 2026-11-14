#!/usr/bin/env node
/**
 * 第三世界 · 三端独立版本构建
 *
 * 产物：
 *   dist/index.html        设备识别与分发页（也承担安装引导）
 *   dist/iphone/           iPhone 版（竖屏、单列、底部标签栏）
 *   dist/ipad/             iPad 版（双列、侧边栏）
 *   dist/mac/              Mac 版（三列、侧边栏 + 顶栏）
 *   dist/version.json      版本与核心一致性指纹
 *
 * 设计约束：
 *   1. 三个版本共用同一份 JS/CSS 字节（同源同哈希），数据契约与算法只有一套，
 *      不存在「iPad 上算出来的 ACWR 和 Mac 上不一样」这种情况。
 *   2. 每个版本有自己的 webmanifest 与 service worker，作用域互不重叠，
 *      因此在同一台设备上可以并存安装、各自独立更新与卸载。
 *   3. 版本差异只体现在布局预设（platform 锁定）与外壳（standalone 全屏）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeIcon } from "./icons.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "prototype");
const DIST = path.join(ROOT, "dist");

const SHARED = ["env.js", "data.js", "live.js", "app.js", "supabase-client.js", "ui-flows.js", "styles.css"];

const PLATFORMS = {
  iphone: {
    id: "iphone",
    label: "iPhone",
    appName: "第三世界 · 训练负荷",
    shortName: "第三世界",
    orientation: "portrait",
    display: "standalone",
    cols: 1,
    themeColor: "#f5f5f7",
    note: "竖屏 · 单列 · 底部标签栏"
  },
  ipad: {
    id: "ipad",
    label: "iPad",
    appName: "第三世界 · 训练负荷",
    shortName: "第三世界 iPad",
    orientation: "any",
    display: "standalone",
    cols: 2,
    themeColor: "#f5f5f7",
    note: "横竖屏 · 双列 · 侧边栏"
  },
  mac: {
    id: "mac",
    label: "Mac",
    appName: "第三世界 · 训练负荷",
    shortName: "第三世界 Mac",
    orientation: "any",
    display: "standalone",
    cols: 3,
    themeColor: "#f5f5f7",
    note: "桌面窗口 · 三列 · 侧边栏 + 顶栏"
  }
};

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const short = (h) => h.slice(0, 8);

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

/* ── 0. 读源文件并计算内容指纹 ───────────────────────────── */
const sources = {};
for (const f of SHARED) sources[f] = fs.readFileSync(path.join(SRC, f));
const baseHtml = fs.readFileSync(path.join(SRC, "index.html"), "utf8");

const coreHashes = Object.fromEntries(Object.entries(sources).map(([f, b]) => [f, sha(b)]));
// 版本号同时包含内容指纹：任何一次改动都会换缓存键，不会出现「改了但用户还看旧的」
const VER = short(sha(Object.values(coreHashes).join("") + baseHtml));
const BUILT_AT = new Date().toISOString();

console.log("构建版本 " + VER + " · " + BUILT_AT);
console.log("核心文件指纹：");
for (const [f, h] of Object.entries(coreHashes)) console.log("  " + f.padEnd(22) + short(h));

/* ── 1. 清理 ─────────────────────────────────────────────── */
rmrf(DIST);
mkdirp(DIST);

const out = {};

for (const p of Object.values(PLATFORMS)) {
  const dir = path.join(DIST, p.id);
  mkdirp(path.join(dir, "icons"));

  // 1.1 共享资源（三个版本字节相同）
  for (const [f, buf] of Object.entries(sources)) {
    fs.writeFileSync(path.join(dir, f), buf);
  }

  // 1.2 index.html
  let html = baseHtml;
  html = html.replace(/\?v=[0-9a-zA-Z]+/g, "?v=" + VER);
  html = html.replace(
    /<title>([^<]*)<\/title>/,
    `<title>${p.appName}</title>
<meta name="description" content="训练负荷、就绪度与跳跃测试的一体化记录与解读。">
<meta name="theme-color" content="${p.themeColor}">
<meta name="color-scheme" content="light dark">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${p.shortName}">
<meta name="format-detection" content="telephone=no">`
  );
  // 版本预设必须早于 app.js：布局锁定、外壳隐藏都由它在启动前决定
  html = html.replace(
    /<script src="env\.js\?v=/,
    `<script>window.ARC_PRESET=${JSON.stringify({
      platform: p.id, standalone: true, lock: true, hint: true, build: VER
    })};</script>
<script src="env.js?v=`
  );
  // service worker：静态资源离线可用；数据请求一律走网络，不缓存业务数据
  html = html.replace(
    "</body>",
    `<script>
if ("serviceWorker" in navigator) {
  addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () { /* 离线能力缺失不影响在线使用 */ });
  });
}
</script>
</body>`
  );
  fs.writeFileSync(path.join(dir, "index.html"), html);

  // 1.3 manifest（三个作用域互不重叠 → 可并存安装）
  const manifest = {
    id: "/" + p.id + "/",
    name: p.appName,
    short_name: p.shortName,
    description: "训练负荷、就绪度与跳跃测试的一体化记录与解读。",
    start_url: "/" + p.id + "/",
    scope: "/" + p.id + "/",
    display: p.display,
    display_override: ["standalone", "minimal-ui"],
    orientation: p.orientation,
    background_color: "#f5f5f7",
    theme_color: p.themeColor,
    lang: "zh-CN",
    dir: "ltr",
    categories: ["health", "sports", "productivity"],
    icons: [
      { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));

  // 1.4 图标：iOS 主屏 180、Android/桌面 192/512、maskable 512
  writeIcon(path.join(dir, "icons/apple-touch-icon.png"), 180);
  writeIcon(path.join(dir, "icons/icon-192.png"), 192);
  writeIcon(path.join(dir, "icons/icon-512.png"), 512);
  writeIcon(path.join(dir, "icons/maskable-512.png"), 512, { tight: true });

  // 1.5 service worker
  const assets = ["./", "./index.html", "./manifest.webmanifest",
    ...SHARED.map((f) => "./" + f + "?v=" + VER)].concat([
      "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png"]);
  const sw = `/* 第三世界 · ${p.label} 版 离线缓存 · ${VER} */
const CACHE = "arc-${p.id}-${VER}";
const ASSETS = ${JSON.stringify(assets, null, 2)};

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith("arc-${p.id}-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 业务数据与鉴权一律直连，不进缓存：宁可报错，也不给过期的训练结论
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).catch(() =>
        new Response("离线状态且本机没有缓存该资源。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })
      );
    })
  );
});
`;
  fs.writeFileSync(path.join(dir, "sw.js"), sw);

  out[p.id] = {
    platform: p.id,
    label: p.label,
    startUrl: "/" + p.id + "/",
    note: p.note,
    columns: p.cols,
    files: Object.fromEntries(Object.entries(coreHashes))
  };
}

/* ── 2. 分发页：设备识别 + 安装引导 ───────────────────────── */
const cards = Object.values(PLATFORMS).map((p) => `
      <a class="card" href="./${p.id}/" data-target="${p.id}">
        <div class="card-top">
          <span class="badge">${p.label}</span>
          <span class="cols">${p.cols} 列</span>
        </div>
        <div class="card-note">${p.note}</div>
        <div class="card-go">进入 ${p.label} 版 →</div>
      </a>`).join("");

const landing = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>第三世界 · 训练负荷与就绪度</title>
<meta name="theme-color" content="#f5f5f7">
<meta name="color-scheme" content="light dark">
<link rel="icon" type="image/png" sizes="192x192" href="./mac/icons/icon-192.png">
<style>
  :root { --bg:#f5f5f7; --surface:#fff; --text:#1d1d1f; --text2:rgba(60,60,67,.62);
    --text3:rgba(60,60,67,.4); --line:rgba(60,60,67,.12); --accent:#007aff;
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",Arial,sans-serif; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0d; --surface:#1c1c1e; --text:#f5f5f7;
    --text2:rgba(235,235,245,.62); --text3:rgba(235,235,245,.38); --line:rgba(255,255,255,.12); --accent:#0a84ff; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font-family:var(--font);
    display:flex; align-items:center; justify-content:center; padding:32px 20px calc(32px + env(safe-area-inset-bottom)); }
  .wrap { width:100%; max-width:880px; }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
  .mark { width:44px; height:44px; border-radius:13px; background:linear-gradient(160deg,#0a84ff,#0046b8);
    display:grid; place-items:center; color:#fff; font-weight:700; font-size:17px; letter-spacing:.02em; }
  h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--text2); font-size:13px; margin:2px 0 0; }
  .hint { margin:18px 0 10px; font-size:13px; color:var(--text2); }
  .hint b { color:var(--text); font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  .card { display:flex; flex-direction:column; gap:8px; padding:16px; border-radius:16px;
    background:var(--surface); border:1px solid var(--line); text-decoration:none; color:inherit;
    transition:transform .18s ease, box-shadow .18s ease; }
  .card:hover { transform:translateY(-2px); box-shadow:0 10px 30px rgba(0,0,0,.08); }
  .card.rec { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .card-top { display:flex; align-items:center; justify-content:space-between; }
  .badge { font-size:13px; font-weight:600; }
  .cols { font-size:11px; color:var(--text3); }
  .card-note { font-size:12px; color:var(--text2); line-height:1.5; }
  .card-go { margin-top:auto; font-size:12px; color:var(--accent); }
  .foot { margin-top:22px; font-size:12px; color:var(--text3); line-height:1.7; }
  .foot code { background:var(--line); padding:1px 5px; border-radius:5px; }
  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:var(--surface);
    border:1px solid var(--line); border-radius:12px; padding:10px 14px; font-size:13px;
    box-shadow:0 12px 40px rgba(0,0,0,.14); opacity:0; transition:opacity .25s; pointer-events:none; }
  .toast.on { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="mark">第</div>
    <div>
      <h1>第三世界</h1>
      <div class="sub">训练负荷与就绪度 · 版本 ${VER}</div>
    </div>
  </div>

  <p class="hint" id="hint">正在识别设备…</p>

  <div class="grid">
${cards}
  </div>

  <div class="foot">
    三个版本共用同一套数据与算法，记录、指标与结论完全一致，只有布局随设备不同。<br>
    安装：iPhone / iPad 用 Safari 打开对应版本 → 分享 → <code>添加到主屏幕</code>；Mac 用 Safari 打开 → 文件 → <code>添加到程序坞</code>，或 Chrome 地址栏的安装按钮。<br>
    <a href="#" id="again" style="color:var(--accent);text-decoration:none">重新检测设备并跳转</a>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function () {
  var ua = navigator.userAgent || "";
  var touch = (navigator.maxTouchPoints || 0) > 1;
  var ipadOS = /Macintosh/.test(ua) && touch;                 // iPadOS 13+ 伪装成 Mac
  var device = /iPhone|iPod/.test(ua) ? "iphone"
    : (/iPad/.test(ua) || ipadOS) ? "ipad"
    : /Macintosh|Mac OS X/.test(ua) ? "mac"
    : (window.matchMedia("(max-width: 500px)").matches ? "iphone"
      : window.matchMedia("(max-width: 1100px)").matches ? "ipad" : "mac");
  var NAME = { iphone: "iPhone", ipad: "iPad", mac: "Mac" };
  var manual = new URLSearchParams(location.search).get("choose") === "1";

  var hint = document.getElementById("hint");
  hint.innerHTML = "检测到本机为 <b>" + NAME[device] + "</b>，已为你标记对应版本。";

  var rec = document.querySelector('[data-target="' + device + '"]');
  if (rec) rec.classList.add("rec");

  if (!manual) {
    // 只在直接访问根路径时自动跳转；带 ?choose=1 时保留选择页，便于人工核对
    setTimeout(function () { location.replace("./" + device + "/"); }, 650);
  }

  document.getElementById("again").addEventListener("click", function (e) {
    e.preventDefault();
    location.href = "./" + device + "/";
  });

  document.querySelectorAll(".card").forEach(function (a) {
    a.addEventListener("click", function () {
      try { localStorage.setItem("arc.platform", a.dataset.target); } catch (err) {}
    });
  });
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(DIST, "index.html"), landing);

/* ── 3. 版本清单（部署后可直接核对线上与本地一致） ────────── */
const version = {
  version: VER,
  builtAt: BUILT_AT,
  core: coreHashes,
  // 三个版本的核心文件哈希必须完全相同，否则说明有人单独改过某一个版本
  coreIdentical: Object.values(out).every((p) =>
    Object.entries(p.files).every(([f, h]) => h === coreHashes[f])),
  platforms: Object.values(PLATFORMS).map((p) => ({
    id: p.id, label: p.label, startUrl: "/" + p.id + "/",
    manifest: "/" + p.id + "/manifest.webmanifest", scope: "/" + p.id + "/",
    orientation: p.orientation, note: p.note
  }))
};
fs.writeFileSync(path.join(DIST, "version.json"), JSON.stringify(version, null, 2));

/* ── 4. 自检：产物必须齐全 ──────────────────────────────── */
const required = (id) => [
  "index.html", "manifest.webmanifest", "sw.js", ...SHARED,
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png"
].map((f) => path.join(DIST, id, f));

let bad = [];
for (const p of Object.values(PLATFORMS)) {
  for (const f of required(p.id)) {
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) bad.push(path.relative(DIST, f));
  }
  const h = fs.readFileSync(path.join(DIST, p.id, "index.html"), "utf8");
  if (!h.includes("ARC_PRESET")) bad.push(p.id + "/index.html 缺版本预设");
  if (!h.includes("manifest.webmanifest")) bad.push(p.id + "/index.html 缺 manifest 引用");
  const m = JSON.parse(fs.readFileSync(path.join(DIST, p.id, "manifest.webmanifest"), "utf8"));
  if (m.scope !== "/" + p.id + "/" || m.start_url !== "/" + p.id + "/") bad.push(p.id + " manifest 作用域不对");
}

console.log("");
console.log("产物：");
for (const p of Object.values(PLATFORMS)) {
  const dir = path.join(DIST, p.id);
  const size = fs.readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .reduce((a, f) => a + fs.statSync(f).size, 0);
  console.log("  " + (p.id + "/").padEnd(9) + p.note.padEnd(24) + (size / 1024).toFixed(0) + " KB");
}
console.log("  核心一致性：" + (version.coreIdentical ? "三个版本字节相同 ✓" : "存在差异 ✗"));
if (bad.length) {
  console.log("\n自检未通过：");
  bad.forEach((b) => console.log("  · " + b));
  process.exit(2);
}
console.log("  自检：" + (Object.keys(PLATFORMS).length * 8) + " 项全部通过 ✓");
console.log("");
