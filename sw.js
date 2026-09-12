// 修正: キャッシュ名にバージョンを付与し、資産パスの修正を確実に反映させる
// （デプロイのたびにこの値を変えないと、古いキャッシュが永久に使われ続ける）
const CACHE_NAME = 'editcode-v3-fix';

// 修正: 実際のファイル配置(js/配下)に合わせてパスを修正。
// 旧: './app.js' のみを指定していたため404となり、cache.addAll()全体が失敗し
// Service Workerのインストールが常に失敗していた（＝push通知が一切機能しない根本原因）。
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icon.png',
  './js/config.js',
  './js/push.js',
  './js/github.js',
  './js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 修正: 1つでも欠けると全滅する addAll ではなく、
      // 個別に取得して失敗したものだけログに残す（インストール自体は継続させる）
      return Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.error('[SW] キャッシュ失敗:', url, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 修正: HTML/JS/CSSはネットワーク優先(なければキャッシュ)にし、
// 一度キャッシュされた古いUIコード（改行表示修正前のstyle.css等）が
// 永久に使われ続ける問題を防ぐ。画像等はキャッシュ優先のままでよい。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const isCodeAsset = /\.(html|js|css)$/.test(new URL(req.url).pathname) || req.mode === 'navigate';

  if (isCodeAsset) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    event.respondWith(
      caches.match(req).then((response) => response || fetch(req))
    );
  }
});

// ================= プッシュ通知受信用ハンドラ =================
self.addEventListener('push', function(event) {
  let data = {
    title: '[System] Maintenance',
    body: 'システムアップデートの準備が完了しました',
    icon: 'icon.png'
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    // 修正: '/icon.png'(ドメイン直下)ではなくSWのスコープ('/EditCode/')基準の相対パスにする
    icon: data.icon || 'icon.png',
    badge: 'icon.png',
    vibrate: data.vibrate || [500, 200, 500],
    requireInteraction: true,
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 通知タップ時の挙動（アプリ画面を開く）
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        // 修正: '/' ではなく現在のSWスコープ('./')に対して開く
        // ('/'だとGitHub Pagesのプロジェクトサイトではドメイン直下=存在しないページに飛んでいた)
        return clients.openWindow('./');
      }
    })
  );
});
