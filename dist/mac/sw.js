/* 第三世界 · Mac 版 离线缓存 · 952f5cb6 */
const CACHE = "arc-mac-952f5cb6";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./env.js?v=952f5cb6",
  "./data.js?v=952f5cb6",
  "./live.js?v=952f5cb6",
  "./app.js?v=952f5cb6",
  "./supabase-client.js?v=952f5cb6",
  "./ui-flows.js?v=952f5cb6",
  "./styles.css?v=952f5cb6",
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
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith("arc-mac-") && k !== CACHE).map((k) => caches.delete(k))))
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
