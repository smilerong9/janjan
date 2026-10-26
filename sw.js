// 잔잔 오프라인 캐시. 앱 파일을 고치면 VERSION을 올린다.
const VERSION = 'janlog-v21';
const FONT_CACHE = 'janlog-fonts';
const FILES = [
  './',
  'index.html',
  'style.css',
  'skins.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
// 글꼴과 글자 인식 데이터: 한 번 받으면 폰에 보관
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // 글꼴: 한 번 받으면 폰에 보관하고 그다음부터는 저장된 것을 쓴다
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(FONT_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      })))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // 앱 파일: 네트워크 우선, 안 되면 캐시 (오프라인에서도 열리게)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
