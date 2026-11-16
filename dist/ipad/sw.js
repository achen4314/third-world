/* 第三世界 · iPad 版 离线缓存 · 81a45700 */
const CACHE = "arc-ipad-81a45700";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./env.js?v=81a45700",
  "./data.js?v=81a45700",
  "./live.js?v=81a45700",
  "./app.js?v=81a45700",
  "./supabase-client.js?v=81a45700",
  "./ui-flows.js?v=81a45700",
  "./styles.css?v=81a45700",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith("arc-ipad-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 业务数据与鉴权一律直连，不进缓存：宁可报错，也不给过期的训练结论
  if (url.origin !== self.location.origin) return;
  const offline = () => new Response("离线状态且本机没有缓存该内容。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });

  // 页面导航用 network-first：HTML 变了就是新版本，不能拿缓存里的旧入口页。
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || offline()))
    );
    return;
  }

  // 带 ?v=<版本> 的静态资源按完整 URL 精确匹配。
  // 绝不能用 ignoreSearch：那会让 ?v= 版本号彻底失效，
  // 新版发布后回访用户仍拿到旧 JS / CSS，界面改动看起来「没生效」。
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(offline))
  );
});
