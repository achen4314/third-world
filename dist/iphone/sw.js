/* 第三世界 · iPhone 版 离线缓存 · 0d87474e */
const CACHE = "arc-iphone-0d87474e";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./env.js?v=0d87474e",
  "./data.js?v=0d87474e",
  "./live.js?v=0d87474e",
  "./app.js?v=0d87474e",
  "./supabase-client.js?v=0d87474e",
  "./ui-flows.js?v=0d87474e",
  "./styles.css?v=0d87474e",
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
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith("arc-iphone-") && k !== CACHE).map((k) => caches.delete(k))))
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
