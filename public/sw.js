// PayCale 配信版 Service Worker
// 役割: ① オフライン用キャッシュ ② Web Push受信・表示 ③ 通知タップ時にアプリを開く
const CACHE_NAME = "paycale-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
];
// index.html が読み込む外部ライブラリ(オフラインでもグラフが出るよう実行時にキャッシュする)
const CACHEABLE_CDN = ["https://cdn.jsdelivr.net/npm/chart.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CACHEABLE_CDN.some((p) => req.url.startsWith(p));
  // Worker(API)・GitHub API・為替APIなどは一切キャッシュしない
  if (!sameOrigin && !isCdn) return;

  if (req.mode === "navigate") {
    // 画面遷移は「ネット優先、失敗したらキャッシュ」(更新を早く反映しつつオフラインでも開ける)
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // その他の静的ファイルは「キャッシュ優先 + 裏で更新」
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "PayCale", body: "通知が届きました" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: data.url || "./index.html" },
  };
  // tag が同じ通知は上書きされる(同じ内容が重複して並ばない)
  if (data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(data.title || "PayCale", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "./index.html", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
