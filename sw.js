const VER = 'meishi-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'lib/tesseract.min.js', 'lib/worker.min.js'];
// OCR用の大きいファイル。取得に失敗してもインストールは止めない
const OCR = ['lib/lang/jpn.traineddata.gz', 'lib/lang/eng.traineddata.gz', 'lib/tesseract-core-simd-lstm.wasm.js', 'lib/tesseract-core-lstm.wasm.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    // cache:'reload' でブラウザの古いキャッシュを使わず、必ず最新を取得する
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await Promise.allSettled(OCR.map(u => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VER) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(r, { ignoreSearch: true });
    if (hit) {
      // アプリ本体は裏で最新版を取得(次回起動から反映)。OCR用の大きなファイルは再取得しない
      if (!r.url.includes('/lib/')) fetch(r).then(async res => { if (res.ok) (await caches.open(VER)).put(r, res); }).catch(() => { });
      return hit;
    }
    try {
      const res = await fetch(r);
      if (res.ok) (await caches.open(VER)).put(r, res.clone());
      return res;
    } catch (err) {
      if (r.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
