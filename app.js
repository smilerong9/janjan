'use strict';

/* =========================================================
   잔잔 — 카페·베이커리 방문 기록
   모든 데이터는 이 기기의 IndexedDB에만 저장된다.
   ========================================================= */

// 미리보기는 따로 저장해서 실제 기록과 섞이지 않게
const DB_NAME = window.JANLOG_PREVIEW ? 'janlog-preview-8' : 'janlog';
const DB_VER = 2;
const BACKUP_KEY = 'janlog.lastBackup';

const KINDS = {
  filter:   { label: '필터커피', short: '필터' },
  espresso: { label: '에스프레소 음료', short: '에스프레소' },
  drink:    { label: '음료', short: '음료' },
  bakery:   { label: '빵·디저트', short: '빵' },
};

const MOOD_SCALES = [
  { k: 'sound', lo: '조용', hi: '북적' },
  { k: 'light', lo: '어둑', hi: '환함' },
  { k: 'space', lo: '아늑', hi: '탁 트임' },
];
const MOOD_INTERIOR = ['우드톤', '미니멀', '빈티지', '모던', '식물 많음', '갤러리 같음'];
const MOOD_GOOD = ['작업하기 좋음', '대화하기 좋음', '혼자 가기 좋음', '창가·뷰가 좋음', '음악 좋음'];
const LEGACY_TAG = { '창가 자리': '창가·뷰가 좋음', '뷰가 좋음': '창가·뷰가 좋음', '테라스': null };
// 예전 태그를 눈금으로 옮기기
const LEGACY_SCALE = { '조용함': ['sound', 1], '북적임': ['sound', 5], '햇살 좋음': ['light', 5], '좌석 넓음': ['space', 4] };
const scaleWord = (k, n) => {
  const s = MOOD_SCALES.find(x => x.k === k);
  if (!s || !n) return '';
  return n <= 2 ? s.lo : n >= 4 ? s.hi : '';
};
function migrateMood(v) {
  v.scales = v.scales || {};
  const out = [];
  (v.moodTags || []).forEach(t => {
    const m = LEGACY_SCALE[t];
    if (m) { if (!v.scales[m[0]]) v.scales[m[0]] = m[1]; return; }
    if (t in LEGACY_TAG) t = LEGACY_TAG[t];
    if (t && !out.includes(t)) out.push(t);
  });
  v.moodTags = out;
  return v;
}

const FLAVORS = ['꽃향', '자스민', '시트러스', '레몬', '오렌지', '자몽', '베리', '딸기', '블루베리',
  '체리', '사과', '복숭아', '살구', '포도', '열대과일', '꿀', '캐러멜', '흑설탕', '초콜릿',
  '견과', '바닐라', '홍차', '허브', '스파이스', '와인'];

const FLAVOR_FAMILY = {
  fruit: ['시트러스', '레몬', '오렌지', '자몽', '베리', '딸기', '블루베리', '체리', '사과', '복숭아', '살구', '포도', '열대과일', '와인'],
  floral: ['꽃향', '자스민'],
  sweet: ['꿀', '캐러멜', '흑설탕', '바닐라'],
  roast: ['초콜릿', '견과'],
  tea: ['홍차', '허브', '스파이스'],
};
const famOf = f => Object.keys(FLAVOR_FAMILY).find(k => FLAVOR_FAMILY[k].includes(f)) || 'etc';
const flavorPill = f => `<span class="pill bean fl-${famOf(f)}">${esc(f)}</span>`;

const PROCESSES = ['', '워시드', '내추럴', '허니', '무산소 발효', '기타'];
const BREWS = ['', '핸드드립', '에어로프레스', '클레버', '사이폰', '콜드브루', '기타'];
const PHOTO_LABELS = ['공간', '메뉴', '안내지'];

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('visits')) d.createObjectStore('visits', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('wishes')) d.createObjectStore('wishes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) {
          const s = d.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('visitId', 'visitId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
function tx(stores, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장이 취소됐어요'));
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const store = {
  allVisits: () => tx(['visits'], 'readonly', t => reqP(t.objectStore('visits').getAll())),
  allPhotos: () => tx(['photos'], 'readonly', t => reqP(t.objectStore('photos').getAll())),
  photo: id => tx(['photos'], 'readonly', t => reqP(t.objectStore('photos').get(id))),
  saveVisit: (visit, addPhotos, removeIds) => tx(['visits', 'photos'], 'readwrite', t => {
    t.objectStore('visits').put(visit);
    const ps = t.objectStore('photos');
    addPhotos.forEach(p => ps.put(p));
    removeIds.forEach(id => ps.delete(id));
  }),
  deleteVisit: visit => tx(['visits', 'photos'], 'readwrite', t => {
    t.objectStore('visits').delete(visit.id);
    const ps = t.objectStore('photos');
    (visit.photos || []).forEach(p => ps.delete(p.id));
  }),
  putMany: (visits, photos, wishes = []) => tx(['visits', 'photos', 'wishes'], 'readwrite', t => {
    const vs = t.objectStore('visits'), ps = t.objectStore('photos'), ws = t.objectStore('wishes');
    visits.forEach(v => vs.put(v));
    photos.forEach(p => ps.put(p));
    wishes.forEach(w => ws.put(w));
  }),
  allWishes: () => tx(['wishes'], 'readonly', t => reqP(t.objectStore('wishes').getAll())),
  saveWish: (wish, addPhotos, removeIds) => tx(['wishes', 'photos'], 'readwrite', t => {
    t.objectStore('wishes').put(wish);
    const ps = t.objectStore('photos');
    addPhotos.forEach(p => ps.put(p));
    removeIds.forEach(id => ps.delete(id));
  }),
  deleteWish: wish => tx(['wishes', 'photos'], 'readwrite', t => {
    t.objectStore('wishes').delete(wish.id);
    const ps = t.objectStore('photos');
    (wish.photos || []).forEach(p => ps.delete(p.id));
  }),
};

/* ---------- 작은 도우미 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = s => {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${Number(m)}.${Number(d)}`;
};
const fmtDateLong = s => {
  if (!s) return '';
  const dt = new Date(s + 'T00:00:00');
  const w = '일월화수목금토'[dt.getDay()];
  const [y, m, d] = s.split('-');
  return `${y}년 ${Number(m)}월 ${Number(d)}일 (${w})`;
};
const monthKey = s => s ? `${s.slice(0, 4)}년 ${Number(s.slice(5, 7))}월` : '날짜 없음';
const starStr = n => n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* 사진 미리보기 URL 캐시 */
const urlCache = new Map();
async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const p = await store.photo(id);
  if (!p) return '';
  const u = URL.createObjectURL(p.blob);
  urlCache.set(id, u);
  return u;
}
function dropURL(id) {
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
}
async function hydrateImages(root) {
  const imgs = $$('img[data-pid]', root);
  await Promise.all(imgs.map(async img => {
    const u = await photoURL(img.dataset.pid);
    if (u) img.src = u;
  }));
}

/* 사진 줄이기: 긴 변 1600px JPEG */
// 고른 사진을 바로 메모리로 복사한다. 안드로이드는 입력칸을 비우거나 시간이 지나면
// 원본 파일을 다시 못 읽을 때가 있다 ("File could not be read! Code=0")
async function takeFiles(input) {
  const list = Array.from(input.files || []);
  const out = [];
  for (const f of list) {
    try { out.push(new File([await f.arrayBuffer()], f.name || 'photo.jpg', { type: f.type || 'image/jpeg', lastModified: f.lastModified })); }
    catch { out.push(f); }
  }
  input.value = '';
  return out;
}
async function shrink(file) {
  const MAX = 1600;
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('사진을 읽지 못했어요'));
      im.src = URL.createObjectURL(file);
    });
  }
  const w = src.width, h = src.height;
  const k = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  return blob || file;
}

/* ---------- 상태 ---------- */
const state = {
  visits: [],
  wishes: [],
  wishDraft: null,
  tab: 'visits',
  calMonth: today().slice(0, 7),
  calDay: null,
  q: '',
  currentId: null,
  draft: null,
};

async function load() {
  state.visits = await store.allVisits();
  state.visits.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  state.wishes = await store.allWishes();
  state.wishes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* ---------- 화면 전환 ---------- */
const VIEWS = ['home', 'detail', 'edit', 'settings', 'wish'];
function showView(name) {
  VIEWS.forEach(v => { $('#view-' + v).hidden = v !== name; });
  window.scrollTo(0, 0);
}
function go(name, params = {}) {
  history.pushState({ view: name, ...params }, '');
  route({ view: name, ...params });
}
function back() {
  if (history.state && history.state.view && history.state.view !== 'home') history.back();
  else route({ view: 'home' });
}
function route(s) {
  const view = (s && s.view) || 'home';
  if (view === 'detail' && s.id) { state.currentId = s.id; renderDetail(); showView('detail'); }
  else if (view === 'edit') { if (!state.draft) startDraft(s.id); renderEdit(); showView('edit'); }
  else if (view === 'settings') { renderSettings(); showView('settings'); }
  else if (view === 'wish') { if (!state.wishDraft) startWishDraft(s.id); renderWishEdit(); showView('wish'); }
  else { state.draft = null; state.wishDraft = null; renderHome(); showView('home'); }
}
window.addEventListener('popstate', e => {
  if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; }
  const s = e.state || { view: 'home' };
  if (s.view !== 'edit') state.draft = null;
  if (s.view !== 'wish') state.wishDraft = null;
  route(s);
});

/* ---------- 검색 ---------- */
function haystack(v) {
  const parts = [v.place, v.area, v.mood, v.memo, v.type, ...(v.moodTags || []), ...Object.entries(v.scales || {}).map(([k, n]) => scaleWord(k, n))];
  (v.items || []).forEach(it => {
    parts.push(it.name, it.note, KINDS[it.kind]?.label);
    if (it.bean) Object.values(it.bean).forEach(x => parts.push(x));
    (it.flavors || []).forEach(f => parts.push(f));
  });
  return parts.filter(Boolean).join(' ').toLowerCase();
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  if (!q) return state.visits;
  const words = q.split(/\s+/);
  return state.visits.filter(v => { const h = haystack(v); return words.every(w => h.includes(w)); });
}

/* ---------- 홈 ---------- */
const CUP_SVG = `<svg class="empty-cup" viewBox="0 0 84 84" aria-hidden="true">
  <path d="M18 34h40v14a20 20 0 0 1-20 20 20 20 0 0 1-20-20z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M58 39h4a7 7 0 0 1 0 14h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M30 16c-3 4 3 7 0 11M40 13c-3 5 3 8 0 13M50 16c-3 4 3 7 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <path d="M12 72h60" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

function emptyHome() {
  return `<div class="empty-state">
    ${CUP_SVG}
    <h2>첫 잔을 남겨볼까요</h2>
    <p>다녀온 카페의 분위기, 마신 커피의 원두와 향미, 안내지 사진까지 한곳에 모아둘 수 있어요.</p>
    <div class="stack" style="max-width:260px;margin:22px auto 0">
      <button class="primary-btn" data-act="new">첫 기록 쓰기</button>
      <button class="ghost-btn center" data-act="sample">예시 기록 넣어보기</button>
    </div>
  </div>`;
}

function itemSummary(v) {
  const names = (v.items || []).map(it => it.name || KINDS[it.kind]?.short).filter(Boolean);
  return names.join(' · ') || '메뉴 기록 없음';
}

function cardHTML(v) {
  const cover = (v.photos || [])[0];
  const tags = [];
  if (v.type === '베이커리') tags.push(`<span class="pill">베이커리</span>`);
  const flv = [];
  (v.items || []).forEach(it => (it.flavors || []).forEach(f => { if (!flv.includes(f)) flv.push(f); }));
  flv.slice(0, 3).forEach(f => tags.push(flavorPill(f)));
  if (v.again === '꼭') tags.push(`<span class="pill navy">또 갈래</span>`);
  if (v.sample) tags.push(`<span class="pill">예시</span>`);
  return `<button class="card" data-open="${esc(v.id)}">
    ${cover ? `<img class="thumb" data-pid="${esc(cover.id)}" alt="">` : `<div class="thumb empty">☕</div>`}
    <div class="card-body">
      <div class="card-top"><span class="card-place">${esc(v.place)}</span><span class="card-date">${fmtDate(v.date)}</span></div>
      <div class="card-items">${esc(itemSummary(v))}</div>
      ${tags.length ? `<div class="card-tags">${tags.join('')}</div>` : ''}
    </div>
  </button>`;
}

function galleryHTML(v) {
  const cover = (v.photos || [])[0];
  const first = (v.items || [])[0];
  const flv = [];
  (v.items || []).forEach(it => (it.flavors || []).forEach(f => { if (!flv.includes(f)) flv.push(f); }));
  const [, m, d] = (v.date || '--').split('-');
  return `<button class="gal-item" data-open="${esc(v.id)}">
    <span class="gal-frame">
      ${cover ? `<img class="gal-img" data-pid="${esc(cover.id)}" alt="">` : `<span class="gal-img empty">${esc((v.place || '?').slice(0, 1))}</span>`}
      <span class="gal-badge" aria-hidden="true"><b>${Number(d) || ''}</b><small>${Number(m) ? Number(m) + '월' : ''}</small></span>
      ${v.again === '꼭' ? '<span class="gal-again">또 갈래</span>' : ''}
    </span>
    <span class="gal-cap"><span class="gal-place">${esc(v.place)}</span><span class="gal-date">${fmtDate(v.date)}</span></span>
    ${first ? `<span class="gal-sub">${esc(first.bean?.name || first.name || '')}</span>` : ''}
    ${flv.length ? `<span class="gal-flv">${flv.slice(0, 4).map(flavorPill).join('')}</span>` : ''}
  </button>`;
}

const skin = () => document.documentElement.getAttribute('data-skin') || 'basic';

const layout = () => document.documentElement.getAttribute('data-layout') || 'grid2';
const weekday = ds => ds ? '일월화수목금토'[new Date(ds + 'T00:00:00').getDay()] : '';
const coverOf = v => (v.photos || [])[0];
const flavorsOf = v => { const out = []; (v.items || []).forEach(it => (it.flavors || []).forEach(f => { if (!out.includes(f)) out.push(f); })); return out; };
const byMonth = list => { const m = new Map(); list.forEach(v => { const k = (v.date || '').slice(0, 7) || '????-??'; if (!m.has(k)) m.set(k, []); m.get(k).push(v); }); return m; };

/* 일기형: 날짜 기둥 + 세로선 */
function diaryHTML(list) {
  let html = '';
  byMonth(list).forEach((vs, ym) => {
    html += `<h2 class="month">${esc(monthKey(vs[0].date))}</h2><div class="diary">`;
    const days = new Map();
    vs.forEach(v => { if (!days.has(v.date)) days.set(v.date, []); days.get(v.date).push(v); });
    days.forEach((dv, ds) => {
      html += `<div class="dy-day">
        <div class="dy-date"><b>${Number((ds || '').slice(8, 10)) || ''}</b><small>${weekday(ds)}</small></div>
        <div class="dy-entries">${dv.map(v => {
          const c = coverOf(v); const f = flavorsOf(v);
          return `<button type="button" class="dy-entry" data-open="${esc(v.id)}">
            <span class="dy-text">
              <span class="dy-place">${esc(v.place)}${v.again === '꼭' ? '<span class="dy-again">또 갈래</span>' : ''}</span>
              <span class="dy-sub">${esc(itemSummary(v))}</span>
              ${f.length ? `<span class="gal-flv">${f.slice(0, 4).map(flavorPill).join('')}</span>` : ''}
            </span>
            ${c ? `<img class="dy-thumb" data-pid="${esc(c.id)}" alt="">` : ''}
          </button>`;
        }).join('')}</div>
      </div>`;
    });
    html += '</div>';
  });
  return html;
}

/* 이달의 요약 + 목록 */
function summaryHTML(list) {
  let html = '';
  byMonth(list).forEach((vs, ym) => {
    const places = new Map();
    vs.forEach(v => places.set(v.place.trim(), (places.get(v.place.trim()) || 0) + 1));
    const cups = vs.reduce((n, v) => n + (v.items || []).filter(it => it.kind !== 'bakery').length, 0);
    const flv = new Map(), fam = new Map();
    vs.forEach(v => (v.items || []).forEach(it => (it.flavors || []).forEach(f => {
      flv.set(f, (flv.get(f) || 0) + 1);
      const k = famOf(f); fam.set(k, (fam.get(k) || 0) + 1);
    })));
    const famTotal = [...fam.values()].reduce((a, b) => a + b, 0);
    const famSorted = [...fam.entries()].sort((a, b) => b[1] - a[1]);
    const topFlv = [...flv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
    const fav = [...places.entries()].sort((a, b) => b[1] - a[1])[0];
    const [y, m] = ym.split('-');
    const FAM_NAME = { fruit: '과일', floral: '꽃', sweet: '단맛', roast: '고소함', tea: '차·허브', etc: '기타' };
    html += `<section class="msum">
      <div class="msum-head"><b>${Number(m) || ''}월</b><span>${y}</span></div>
      <div class="msum-stats">
        <div><b>${vs.length}</b><span>방문</span></div>
        <div><b>${places.size}</b><span>카페</span></div>
        <div><b>${cups}</b><span>잔</span></div>
      </div>
      ${famTotal ? `<div class="msum-flv">
        <div class="msum-bar" aria-hidden="true">${famSorted.map(([k, n]) => `<i class="fb-${k}" style="flex:${n}"></i>`).join('')}</div>
        <p class="msum-line">이달은 <b>${FAM_NAME[famSorted[0][0]]}</b> 향이 제일 많았어요</p>
        <p class="msum-legend">${famSorted.map(([k, n]) => `<span><i class="fb-${k}"></i>${FAM_NAME[k]} ${n}</span>`).join('')}</p>
      </div>` : ''}
      ${fav && fav[1] > 1 ? `<p class="msum-line">자주 간 곳 <b>${esc(fav[0])}</b> ${fav[1]}번</p>` : ''}
      <div class="msum-rows">${vs.map(v => `<button type="button" class="msum-row" data-open="${esc(v.id)}">
        <span class="msum-date">${fmtDate(v.date)}</span>
        <span class="msum-place">${esc(v.place)}</span>
        <span class="msum-menu">${esc(itemSummary(v))}</span>
      </button>`).join('')}</div>
    </section>`;
  });
  return html;
}

function renderVisits(list) {
  if (!state.visits.length) return emptyHome();
  if (!list.length) return `<div class="empty-state"><h2>찾는 기록이 없어요</h2><p>다른 단어로 검색해 보세요.</p></div>`;
  const gallery = skin() === 'gallery' || skin() === 'pop';
  if (gallery && layout() === 'diary') return diaryHTML(list);
  if (gallery && layout() === 'summary') return summaryHTML(list);
  let html = '', cur = null, open = false;
  list.forEach(v => {
    const mk = monthKey(v.date);
    if (mk !== cur) {
      if (open) html += '</div>';
      html += `<h2 class="month">${esc(mk)}</h2><div class="${gallery ? 'gal' : 'list'}">`;
      cur = mk; open = true;
    }
    html += gallery ? galleryHTML(v) : cardHTML(v);
  });
  if (open) html += '</div>';
  return html;
}

function renderBeans(list) {
  const rows = [];
  list.forEach(v => (v.items || []).forEach(it => {
    if ((it.kind === 'filter' || it.kind === 'espresso') && (it.bean?.name || it.name)) rows.push({ v, it });
  }));
  if (!rows.length) {
    return `<div class="empty-state">${CUP_SVG}<h2>원두 노트가 비어 있어요</h2>
      <p>필터커피를 기록하면 원두, 산지, 가공 방식, 향미가 여기에 모여요. 이달의 커피를 비교하기 좋아요.</p></div>`;
  }
  return `<div class="list" style="margin-top:12px">${rows.map(({ v, it }) => {
    const b = it.bean || {};
    const meta = [b.origin, b.farm, b.variety, b.process].filter(Boolean).map(esc).join(' · ');
    return `<button class="bean-card" data-open="${esc(v.id)}">
      <div class="bean-name">${esc(b.name || it.name)}</div>
      ${meta ? `<div class="bean-meta">${meta}</div>` : ''}
      ${(it.flavors || []).length ? `<div class="card-tags">${it.flavors.map(flavorPill).join('')}</div>` : ''}
      <div class="bean-foot"><span>${esc(v.place)}${b.roaster && b.roaster !== v.place ? ' · ' + esc(b.roaster) : ''}</span><span>${it.rating ? starStr(it.rating) + ' ' : ''}${fmtDate(v.date)}</span></div>
    </button>`;
  }).join('')}</div>`;
}

function renderPlaces(list) {
  const m = new Map();
  list.forEach(v => {
    const k = v.place.trim();
    if (!m.has(k)) m.set(k, { name: k, type: v.type, count: 0, last: v.date });
    const p = m.get(k);
    p.count++;
    if ((v.date || '') > (p.last || '')) p.last = v.date;
  });
  const arr = [...m.values()].sort((a, b) => b.count - a.count || (b.last || '').localeCompare(a.last || ''));
  if (!arr.length) return renderVisits(list);
  return `<div style="margin-top:6px">${arr.map(p => `<button class="place-row" data-place="${esc(p.name)}">
      <span class="place-name">${esc(p.name)}</span>
      <span class="place-type">${esc(p.type || '')}</span>
      <span class="place-count">${p.count}번 · ${fmtDate(p.last)}</span>
    </button>`).join('')}</div>`;
}

/* ---------- 달력 ---------- */
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function renderCal(list) {
  const ym = state.calMonth;
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = first.getDay();
  const byDay = new Map();
  list.forEach(v => {
    if (!v.date || v.date.slice(0, 7) !== ym) return;
    const d = Number(v.date.slice(8, 10));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(v);
  });
  const monthVisits = [...byDay.values()].flat();
  const places = new Set(monthVisits.map(v => v.place.trim()));
  const cups = monthVisits.reduce((a, v) => a + (v.items || []).filter(it => it.kind !== 'bakery').length, 0);
  const t = today();
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cal-cell blank" aria-hidden="true"></span>';
  for (let d = 1; d <= days; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    const vs = byDay.get(d) || [];
    const dow = (lead + d - 1) % 7;
    const cls = ['cal-cell', vs.length ? 'has' : '', ds === t ? 'today' : '', state.calDay === d ? 'sel' : '', dow === 0 ? 'sun' : '', dow === 6 ? 'sat' : ''].filter(Boolean).join(' ');
    if (!vs.length) { cells += `<span class="${cls}"><span class="cal-num">${d}</span></span>`; continue; }
    const cover = vs.map(v => (v.photos || [])[0]).find(Boolean);
    cells += `<button type="button" class="${cls}" data-day="${d}" aria-label="${m}월 ${d}일 기록 ${vs.length}개">
      ${cover ? `<img class="cal-img" data-pid="${esc(cover.id)}" alt="">` : ''}
      <span class="cal-num">${d}</span>
      ${vs.length > 1 ? `<span class="cal-count">${vs.length}</span>` : ''}
    </button>`;
  }
  const sel = state.calDay && byDay.get(state.calDay);
  const below = sel
    ? `<h2 class="month">${m}월 ${state.calDay}일</h2><div class="list">${sel.map(cardHTML).join('')}</div>`
    : monthVisits.length
      ? `<h2 class="month">이번 달 기록</h2><div class="list">${monthVisits.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(cardHTML).join('')}</div>`
      : `<p class="cal-empty">${m}월에는 아직 기록이 없어요.</p>`;
  return `<section class="cal">
    <div class="cal-head">
      <button type="button" class="icon-btn" data-cal-nav="-1" aria-label="이전 달">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="cal-title"><b>${y}년 ${m}월</b>
        <span class="cal-sum">${monthVisits.length ? `${places.size}곳 · ${monthVisits.length}번 방문 · ${cups}잔` : '기록 없음'}</span></div>
      <button type="button" class="icon-btn" data-cal-nav="1" aria-label="다음 달">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="cal-dow" aria-hidden="true"><span class="sun">일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span class="sat">토</span></div>
    <div class="cal-grid">${cells}</div>
    ${ym !== t.slice(0, 7) ? '<button type="button" class="cal-today" data-cal-today>이번 달로</button>' : ''}
  </section>
  ${below}`;
}

function renderHome() {
  $$('.tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === state.tab));
  const beanCount = state.visits.reduce((n, v) => n + (v.items || []).filter(it => (it.kind === 'filter' || it.kind === 'espresso') && (it.bean?.name || it.name)).length, 0);
  const counts = {
    visits: state.visits.length,
    cal: state.visits.filter(v => (v.date || '').startsWith(today().slice(0, 7))).length,
    wish: state.wishes.filter(w => !w.visitedId).length,
    beans: beanCount,
    places: new Set(state.visits.map(v => v.place.trim())).size,
  };
  $$('.tab-n').forEach(s => { const n = counts[s.dataset.n]; s.textContent = n ? String(n) : ''; });
  const list = filtered();
  const body = $('#home-body');
  body.innerHTML = state.tab === 'beans' ? renderBeans(list) : state.tab === 'places' ? renderPlaces(list) : state.tab === 'cal' ? renderCal(list) : state.tab === 'wish' ? renderWishes() : renderVisits(list);
  hydrateImages(body);
  $('#btn-new').hidden = false;
  const wishMode = state.tab === 'wish';
  $('#btn-new .fab-lbl').textContent = wishMode ? '가볼 곳 추가' : '기록하기';
  $('#btn-new').setAttribute('aria-label', wishMode ? '가볼 곳 추가' : '기록하기');
  $('#btn-new').classList.toggle('is-wish', wishMode);
}

$('#home-body').addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) return go('detail', { id: open.dataset.open });
  const place = e.target.closest('[data-place]');
  if (place) {
    state.q = place.dataset.place;
    $('#q').value = state.q;
    state.tab = 'visits';
    return renderHome();
  }
  const nav = e.target.closest('[data-cal-nav]');
  if (nav) { state.calMonth = shiftMonth(state.calMonth, Number(nav.dataset.calNav)); state.calDay = null; return renderHome(); }
  if (e.target.closest('[data-cal-today]')) { state.calMonth = today().slice(0, 7); state.calDay = null; return renderHome(); }
  const day = e.target.closest('[data-day]');
  if (day) {
    const d = Number(day.dataset.day);
    const ds = `${state.calMonth}-${String(d).padStart(2, '0')}`;
    const vs = filtered().filter(v => v.date === ds);
    if (vs.length === 1) return go('detail', { id: vs[0].id });
    state.calDay = state.calDay === d ? null : d;
    return renderHome();
  }
  const act = e.target.closest('[data-act]');
  if (act?.dataset.act === 'new') return newVisit();
  if (act?.dataset.act === 'sample') return addSample();
});
$$('.tab').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderHome(); }));
$('#q').addEventListener('input', e => { state.q = e.target.value; renderHome(); });
$('#btn-new').addEventListener('click', () => {
  if (state.tab === 'wish') { state.wishDraft = null; return go('wish'); }
  newVisit();
});
$('#btn-settings').addEventListener('click', () => go('settings'));
$$('[data-back]').forEach(b => b.addEventListener('click', back));

/* ---------- 예시 기록 (그림으로 그린 예시 사진 포함) ---------- */
function canvasBlob(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.85));
}
function grain(ctx, w, h, a) {
  for (let i = 0; i < w * h / 90; i++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${a * Math.random()})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}
function paintTable(ctx, w, h, base) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 14 + Math.random() * 20) {
    ctx.strokeStyle = `rgba(60,35,20,${0.05 + Math.random() * 0.08})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 60) ctx.lineTo(x, y + Math.sin(x / 140 + y) * 6);
    ctx.stroke();
  }
}
function paintCup(coffee, crema, cup, table) {
  return (ctx, w, h) => {
    paintTable(ctx, w, h, table);
    const cx = w * 0.48, cy = h * 0.52, R = w * 0.34;
    const sh = ctx.createRadialGradient(cx + 30, cy + 40, R * 0.6, cx + 30, cy + 40, R * 1.45);
    sh.addColorStop(0, 'rgba(0,0,0,0.28)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(cx + 30, cy + 40, R * 1.45, 0, 7); ctx.fill();
    ctx.fillStyle = cup; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 6; ctx.stroke();
    ctx.fillStyle = cup; ctx.beginPath(); ctx.arc(cx, cy, R * 0.82, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + R * 0.95, cy - R * 0.1, R * 0.28, R * 0.12, -0.2, 0, 7); ctx.fill();
    const cg = ctx.createRadialGradient(cx - 20, cy - 20, 10, cx, cy, R * 0.7);
    cg.addColorStop(0, crema); cg.addColorStop(0.75, coffee); cg.addColorStop(1, '#2a160c');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, R * 0.7, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(cx - R * 0.3, cy - R * 0.35, R * 0.18, R * 0.06, -0.6, 0, 7); ctx.fill();
    grain(ctx, w, h, 0.05);
  };
}
function paintRoom(wall, wood, light) {
  return (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, wall); g.addColorStop(1, '#3b3530');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = light; ctx.globalAlpha = 0.9;
    ctx.fillRect(w * 0.12, h * 0.1, w * 0.36, h * 0.42);
    ctx.fillRect(w * 0.52, h * 0.1, w * 0.36, h * 0.42);
    ctx.globalAlpha = 0.18;
    ctx.beginPath(); ctx.moveTo(w * 0.12, h * 0.52); ctx.lineTo(w * 0.88, h * 0.52); ctx.lineTo(w, h * 0.95); ctx.lineTo(w * 0.3, h); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = wood; ctx.fillRect(0, h * 0.68, w, h * 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, h * 0.74, w, h * 0.02);
    ctx.fillStyle = wood;
    [[0.2, 0.74], [0.78, 0.74]].forEach(([x, y]) => ctx.fillRect(w * x, h * y, w * 0.025, h * 0.26));
    ctx.fillStyle = '#e9e4da'; ctx.beginPath(); ctx.arc(w * 0.62, h * 0.66, w * 0.035, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#4f6a4a';
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.ellipse(w * 0.3 + Math.cos(i) * 22, h * 0.6 - i * 14, 14, 30, i * 0.7, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#b48a62'; ctx.fillRect(w * 0.28, h * 0.62, w * 0.05, h * 0.06);
    grain(ctx, w, h, 0.06);
  };
}
function paintFlyer(lines, table) {
  return (ctx, w, h) => {
    paintTable(ctx, w, h, table);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(-0.04);
    const pw = w * 0.72, ph = h * 0.78;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-pw / 2 + 14, -ph / 2 + 18, pw, ph);
    ctx.fillStyle = '#f7f3ea'; ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
    ctx.fillStyle = '#2b2620'; ctx.textAlign = 'center';
    ctx.font = `600 ${w * 0.03}px sans-serif`; ctx.fillText('THIS MONTH', 0, -ph / 2 + h * 0.09);
    ctx.font = `700 ${w * 0.058}px sans-serif`; ctx.fillText(lines[0], 0, -ph / 2 + h * 0.17);
    ctx.strokeStyle = '#2b2620'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-pw * 0.3, -ph / 2 + h * 0.21); ctx.lineTo(pw * 0.3, -ph / 2 + h * 0.21); ctx.stroke();
    ctx.font = `400 ${w * 0.036}px sans-serif`;
    lines.slice(1).forEach((l, i) => ctx.fillText(l, 0, -ph / 2 + h * (0.28 + i * 0.065)));
    ctx.restore();
    grain(ctx, w, h, 0.04);
  };
}
function paintPastry(table) {
  return (ctx, w, h) => {
    paintTable(ctx, w, h, table);
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.arc(cx + 18, cy + 24, w * 0.38, 0, 7); ctx.fill();
    ctx.fillStyle = '#f2efe8'; ctx.beginPath(); ctx.arc(cx, cy, w * 0.38, 0, 7); ctx.fill();
    for (let i = -3; i <= 3; i++) {
      const g = ctx.createLinearGradient(0, cy - 60, 0, cy + 60);
      g.addColorStop(0, '#e2a55a'); g.addColorStop(1, '#a5612a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx + i * w * 0.055, cy + Math.abs(i) * 12, w * 0.06, w * (0.17 - Math.abs(i) * 0.025), i * 0.18, 0, 7); ctx.fill();
    }
    grain(ctx, w, h, 0.05);
  };
}

function paintLatte(cupColor, table, art) {
  return (ctx, w, h) => {
    paintTable(ctx, w, h, table);
    const cx = w * 0.5, cy = h * 0.5, R = w * 0.33;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(cx + 24, cy + 30, R * 1.3, 0, 7); ctx.fill();
    ctx.fillStyle = cupColor; ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + R * 1.05, cy, R * 0.3, R * 0.13, 0, 0, 7); ctx.fill();
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, R * 0.85);
    g.addColorStop(0, '#c48a55'); g.addColorStop(1, '#7a4422');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 0.85, 0, 7); ctx.fill();
    ctx.fillStyle = art;
    ctx.beginPath();
    ctx.moveTo(cx, cy + R * 0.42);
    ctx.bezierCurveTo(cx - R * 0.75, cy - R * 0.05, cx - R * 0.35, cy - R * 0.62, cx, cy - R * 0.22);
    ctx.bezierCurveTo(cx + R * 0.35, cy - R * 0.62, cx + R * 0.75, cy - R * 0.05, cx, cy + R * 0.42);
    ctx.fill();
    grain(ctx, w, h, 0.05);
  };
}

const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function addSample(quiet) {
  const W = 900, H = 1125;
  const specs = [
    {
      v: { date: today(), type: '카페', place: '예시 로스터스', area: '골목 안쪽 2층',
        scales: { sound: 1, light: 4, space: 2 }, moodTags: ['우드톤', '창가·뷰가 좋음'],
        mood: '창가 바 자리에 오후 햇살이 길게 들어온다. 음악은 낮은 재즈.',
        items: [
          { kind: 'filter', name: '이달의 커피', rating: 5,
            bean: { name: '에티오피아 구지 함벨라', origin: '에티오피아 구지', farm: '함벨라 워시드 스테이션', variety: '에어룸', process: '워시드', roaster: '예시 로스터스', brew: '핸드드립' },
            flavors: ['자스민', '복숭아', '홍차'], acidity: 4, sweetness: 4, body: 2,
            note: '식으면서 복숭아 단맛이 또렷해짐. 안내지에는 베르가못도 적혀 있었다.' },
          { kind: 'bakery', name: '버터 스콘', rating: 4, note: '겉은 바삭, 속은 촉촉' }],
        memo: '이달의 커피 중 제일 좋았다.', again: '꼭' },
      photos: [['공간', paintRoom('#d9cbb7', '#7a5536', '#fff6e2')], ['안내지', paintFlyer(['ETHIOPIA GUJI', 'Hambela Washed', 'Heirloom · Washed', 'Jasmine / Peach / Black tea'], '#9c7350')], ['메뉴', paintCup('#5a3018', '#c98a4f', '#f4f1ea', '#a4794f')]],
    },
    {
      v: { date: daysAgo(9), type: '베이커리', place: '예시 베이커리', area: '시장 입구',
        scales: { sound: 5, light: 4, space: 2 }, moodTags: ['대화하기 좋음'],
        mood: '오전에 빵 나오는 시간 맞춰 가면 줄이 길다. 버터 향이 가게 밖까지.',
        items: [
          { kind: 'bakery', name: '크루아상', rating: 5, note: '결이 살아 있고 버터가 진하다' },
          { kind: 'espresso', name: '플랫화이트', rating: 3, bean: { name: '하우스 블렌드', origin: '', farm: '', variety: '', process: '', roaster: '', brew: '' }, flavors: ['초콜릿', '견과'], note: '무난' }],
        memo: '빵은 최고, 커피는 평범.', again: '가끔' },
      photos: [['메뉴', paintPastry('#8b6544')], ['공간', paintRoom('#c9b49a', '#5e3f28', '#ffe9c4')]],
    },
    {
      v: { date: daysAgo(24), type: '카페', place: '예시 커피 바', area: '바다 보이는 쪽',
        scales: { sound: 2, light: 5, space: 5 }, moodTags: ['미니멀', '창가·뷰가 좋음', '음악 좋음'],
        mood: '흰 벽에 원목 바 하나. 바다 쪽 통창.',
        items: [
          { kind: 'filter', name: '게이샤 핸드드립', rating: 4,
            bean: { name: '콜롬비아 엘 파라이소 리치', origin: '콜롬비아 카우카', farm: '엘 파라이소', variety: '게이샤', process: '무산소 발효', roaster: '', brew: '핸드드립' },
            flavors: ['딸기', '와인', '꽃향'], acidity: 3, sweetness: 5, body: 3,
            note: '딸기잼 같은 단맛. 호불호 있을 듯.' }],
        memo: '', again: '꼭' },
      photos: [['메뉴', paintCup('#4a2614', '#b3713c', '#e9e6df', '#6f5038')], ['안내지', paintFlyer(['COLOMBIA CAUCA', 'El Paraiso Lychee', 'Gesha · Anaerobic', 'Strawberry / Wine / Floral'], '#5f4430')]],
    },
  ];
  specs.push(
    {
      v: { date: daysAgo(3), type: '카페', place: '예시 필터 하우스', area: '전포 골목',
        scales: { sound: 2, light: 3, space: 1 }, moodTags: ['빈티지', '혼자 가기 좋음'],
        mood: '바 좌석 여섯 개. 사장님이 원두 설명을 자세히 해준다.',
        items: [
          { kind: 'filter', name: '케냐 AA', rating: 4,
            bean: { name: '케냐 니에리 AA', origin: '케냐 니에리', farm: '', variety: 'SL28', process: '워시드', roaster: '', brew: '핸드드립' },
            flavors: ['자몽', '블루베리', '흑설탕'], acidity: 5, sweetness: 3, body: 3, note: '산미가 쨍한데 끝이 달다.' }],
        memo: '', again: '가끔' },
      photos: [['메뉴', paintCup('#3d1f10', '#a9663a', '#2c3d5b', '#5b4030')]],
    },
    {
      v: { date: daysAgo(6), type: '카페', place: '예시 라떼 스탠드', area: '광안리 해변',
        scales: { sound: 4, light: 5, space: 3 }, moodTags: ['모던', '대화하기 좋음', '창가·뷰가 좋음'],
        mood: '바다 보이는 2층. 주말엔 시끌벅적.',
        items: [
          { kind: 'espresso', name: '바닐라빈 라떼', rating: 4, bean: { name: '시즌 블렌드', origin: '', farm: '', variety: '', process: '', roaster: '', brew: '' }, flavors: ['바닐라', '캐러멜'], note: '달지만 우유가 고소하다' },
          { kind: 'bakery', name: '휘낭시에', rating: 3 }],
        memo: '', again: '가끔' },
      photos: [['메뉴', paintLatte('#e9e3d8', '#9c7350', '#f6efe2')], ['공간', paintRoom('#cfd6da', '#8b6a4c', '#f3fbff')]],
    },
    {
      v: { date: daysAgo(6), type: '베이커리', place: '예시 빵공방', area: '영도',
        scales: { sound: 3, light: 4, space: 2 }, moodTags: ['우드톤'],
        mood: '', items: [{ kind: 'bakery', name: '소금빵', rating: 5, note: '겉은 바삭, 버터가 쭉' }],
        memo: '라떼 마시고 바로 이어서 들렀다.', again: '꼭' },
      photos: [['메뉴', paintPastry('#6f5038')]],
    },
    {
      v: { date: daysAgo(13), type: '카페', place: '예시 티룸', area: '망미',
        scales: { sound: 1, light: 2, space: 2 }, moodTags: ['식물 많음', '작업하기 좋음'],
        mood: '조명이 낮고 식물이 많다. 노트북 하기 좋음.',
        items: [
          { kind: 'filter', name: '과테말라 핸드드립', rating: 3,
            bean: { name: '과테말라 우에우에테낭고', origin: '과테말라', farm: '', variety: '버번', process: '워시드', roaster: '', brew: '핸드드립' },
            flavors: ['초콜릿', '견과', '캐러멜'], acidity: 2, sweetness: 3, body: 4, note: '편하게 마시기 좋은 맛' },
          { kind: 'drink', name: '얼그레이 밀크티', rating: 4 }],
        memo: '', again: '가끔' },
      photos: [['공간', paintRoom('#6c6a58', '#4a3626', '#e8d9a8')], ['메뉴', paintCup('#2e180c', '#7d4a28', '#d9d3c8', '#4b3a2c')]],
    },
    {
      v: { date: daysAgo(30), type: '카페', place: '예시 로스터스', area: '골목 안쪽 2층',
        scales: { sound: 1, light: 4, space: 2 }, moodTags: ['우드톤'],
        mood: '', items: [
          { kind: 'filter', name: '지난달 이달의 커피', rating: 4,
            bean: { name: '파나마 에스메랄다', origin: '파나마 보케테', farm: '에스메랄다', variety: '게이샤', process: '내추럴', roaster: '', brew: '핸드드립' },
            flavors: ['자스민', '열대과일', '꿀'], acidity: 3, sweetness: 5, body: 2, note: '꽃향이 엄청 진함' }],
        memo: '', again: '꼭' },
      photos: [['메뉴', paintCup('#5a3018', '#d39a5c', '#f4f1ea', '#8a6040')], ['안내지', paintFlyer(['PANAMA BOQUETE', 'Esmeralda', 'Gesha · Natural', 'Jasmine / Tropical / Honey'], '#7d5a3e')]],
    },
  );
  for (const s of specs) {
    const v = { id: uid(), sample: true, photos: [], createdAt: Date.now(), updatedAt: Date.now(), ...s.v };
    v.items = v.items.map(it => ({ id: uid(), note: '', rating: 0, ...it }));
    const add = [];
    for (const [label, paint] of s.photos) {
      const blob = await canvasBlob(W, H, paint);
      const id = uid();
      v.photos.push({ id, label });
      add.push({ id, visitId: v.id, blob });
    }
    await store.saveVisit(v, add, []);
  }
  // 예시 가볼 곳 2개
  const shot = await canvasBlob(720, 1280, (ctx, w, h) => {
    paintTable(ctx, w, h, '#7d5a3e');
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e6ff6a'; ctx.font = `800 ${w * 0.13}px sans-serif`; ctx.fillText('예시 커피스탠드', w * 0.06, h * 0.16);
    ctx.fillStyle = '#111'; ctx.fillRect(w * 0.06, h * 0.2, w * 0.16, h * 0.045);
    ctx.fillStyle = '#fff'; ctx.font = `600 ${w * 0.05}px sans-serif`; ctx.fillText('망미', w * 0.085, h * 0.235);
    [['드립 맛집 발견', 0.62], ['주말엔 웨이팅 있어요', 0.7]].forEach(([s, y]) => {
      ctx.fillStyle = '#fff'; ctx.fillRect(w * 0.08, h * y - h * 0.035, w * 0.6, h * 0.05);
      ctx.fillStyle = '#111'; ctx.font = `500 ${w * 0.045}px sans-serif`; ctx.fillText(s, w * 0.1, h * y);
    });
  });
  const shotId = uid();
  const w1 = { id: uid(), sample: true, name: '예시 커피스탠드', area: '망미', type: '카페', memo: '주말엔 웨이팅 있음. 드립 라인업 많다고 함', photos: [{ id: shotId, label: '캡처' }], createdAt: Date.now() };
  const w2 = { id: uid(), sample: true, name: '예시 빵공방', area: '영도', type: '베이커리', memo: '소금빵이 유명', photos: [], createdAt: Date.now() - 1000 };
  await store.saveWish(w1, [{ id: shotId, visitId: w1.id, blob: shot }], []);
  await store.saveWish(w2, [], []);
  await load();
  renderHome();
  if (!quiet) toast('예시 기록과 가볼 곳을 넣었어요');
}

/* ---------- 상세 ---------- */
function renderDetail() {
  const v = state.visits.find(x => x.id === state.currentId);
  const body = $('#detail-body');
  if (!v) { body.innerHTML = '<div class="empty-state"><h2>기록을 찾지 못했어요</h2></div>'; return; }
  $('#detail-title').textContent = v.place;
  const photos = v.photos || [];
  let html = '';
  if (photos.length) {
    html += `<div class="d-hero">${photos.map(p => `<button data-lb="${esc(p.id)}" data-cap="${esc(p.label || '')}">
      <img data-pid="${esc(p.id)}" alt="${esc(p.label || '사진')}">${p.label === '안내지' ? '<span class="pill bean">안내지</span>' : ''}</button>`).join('')}</div>`;
  }
  html += `<div class="d-head">
    <h1 class="d-place">${esc(v.place)}</h1>
    <div class="d-sub"><span class="num">${fmtDateLong(v.date)}</span>${v.type ? `<span>${esc(v.type)}</span>` : ''}${v.area ? `<span>${esc(v.area)}</span>` : ''}</div>
  </div>`;

  migrateMood(v);
  const sc = MOOD_SCALES.filter(s => v.scales[s.k]);
  if ((v.moodTags || []).length || v.mood || sc.length) {
    html += `<section class="d-section"><h3>분위기</h3>
      ${sc.length ? `<div class="d-scales">${sc.map(s => `<div class="d-scale"><span>${s.lo}</span><span class="dots" aria-label="${scaleWord(s.k, v.scales[s.k]) || '중간'}">${[1, 2, 3, 4, 5].map(n => `<i class="${n === v.scales[s.k] ? 'on' : ''}"></i>`).join('')}</span><span>${s.hi}</span></div>`).join('')}</div>` : ''}
      ${(v.moodTags || []).length ? `<div class="card-tags">${v.moodTags.map(t => `<span class="pill navy">${esc(t)}</span>`).join('')}</div>` : ''}
      ${v.mood ? `<p class="d-text">${esc(v.mood)}</p>` : ''}</section>`;
  }

  if ((v.items || []).length) {
    html += `<section class="d-section"><h3>먹고 마신 것</h3>${v.items.map(itemDetail).join('')}</section>`;
  }

  if (v.memo || v.again) {
    html += `<section class="d-section"><h3>정리</h3>
      ${v.memo ? `<p class="d-text">${esc(v.memo)}</p>` : ''}
      ${v.again ? `<div><span class="pill navy">다시 갈래요: ${esc(v.again)}</span></div>` : ''}</section>`;
  }
  body.innerHTML = html;
  hydrateImages(body);
}

function itemDetail(it) {
  const k = KINDS[it.kind] || KINDS.drink;
  const b = it.bean || {};
  const beanRows = [['원두', b.name], ['산지', b.origin], ['농장', b.farm], ['품종', b.variety], ['가공', b.process], ['로스터리', b.roaster], ['추출', b.brew]]
    .filter(([, x]) => x);
  const bars = [['산미', it.acidity], ['단맛', it.sweetness], ['바디', it.body]].filter(([, x]) => x);
  return `<article class="d-item">
    <div class="d-item-top"><span class="pill kind-${it.kind} ${it.kind === 'filter' || it.kind === 'espresso' ? 'bean' : ''}">${esc(k.short)}</span>
      <span class="d-item-name">${esc(it.name || k.label)}</span>
      ${it.rating ? `<span class="d-stars" aria-label="별점 ${it.rating}점">${starStr(it.rating)}</span>` : ''}</div>
    ${beanRows.length ? `<dl class="d-bean">${beanRows.map(([a, x]) => `<dt>${a}</dt><dd>${esc(x)}</dd>`).join('')}</dl>` : ''}
    ${(it.flavors || []).length ? `<div class="card-tags">${it.flavors.map(flavorPill).join('')}</div>` : ''}
    ${bars.length ? `<div class="bars">${bars.map(([a, x]) => `<div class="bar-row"><span>${a}</span><div class="bar"><i style="width:${x * 20}%"></i></div></div>`).join('')}</div>` : ''}
    ${it.note ? `<p class="d-text">${esc(it.note)}</p>` : ''}
  </article>`;
}

$('#detail-body').addEventListener('click', async e => {
  const b = e.target.closest('[data-lb]');
  if (!b) return;
  $('#lb-img').src = await photoURL(b.dataset.lb);
  $('#lb-cap').textContent = b.dataset.cap || '';
  $('#lightbox').hidden = false;
});
$('#lb-close').addEventListener('click', () => { $('#lightbox').hidden = true; });
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });
$('#btn-edit').addEventListener('click', () => { state.draft = null; go('edit', { id: state.currentId }); });

/* ---------- 작성·수정 ---------- */
function blankItem(kind) {
  const it = { id: uid(), kind, name: '', rating: 0, note: '' };
  if (kind === 'filter' || kind === 'espresso') {
    it.bean = { name: '', origin: '', farm: '', variety: '', process: '', roaster: '', brew: kind === 'filter' ? '핸드드립' : '' };
    it.flavors = [];
  }
  if (kind === 'filter') { it.acidity = 0; it.sweetness = 0; it.body = 0; }
  return it;
}

function startDraft(id) {
  const src = id ? state.visits.find(v => v.id === id) : null;
  if (src) {
    const d = migrateMood(JSON.parse(JSON.stringify(src)));
    d.photos = (src.photos || []).map(p => ({ ...p }));
    state.draft = { v: d, isNew: false, newBlobs: new Map(), removed: [] };
  } else {
    state.draft = {
      v: { id: uid(), date: today(), type: '카페', place: '', area: '', moodTags: [], scales: {}, mood: '',
        items: [], memo: '', again: '', photos: [], createdAt: Date.now() },
      isNew: true, newBlobs: new Map(), removed: [],
    };
  }
}

function newVisit() { state.draft = null; go('edit'); }

function renderEdit() {
  const { v, isNew } = state.draft;
  $('#edit-title').textContent = isNew ? '새 기록' : '기록 수정';
  $('#f-date').value = v.date || today();
  $('#f-place').value = v.place || '';
  $('#f-area').value = v.area || '';
  $('#f-mood').value = v.mood || '';
  $('#f-memo').value = v.memo || '';
  setSeg('#f-type', v.type || '카페');
  setSeg('#f-again', v.again || '');
  $('#place-list').innerHTML = [...new Set(state.visits.map(x => x.place))].map(p => `<option value="${esc(p)}"></option>`).join('');
  renderMoodTags();
  renderPhotos();
  renderItems();
  $('#delete-zone').hidden = isNew;
  $('#delete-confirm').hidden = true;
  $('#btn-delete').hidden = false;
}

function setSeg(sel, val) {
  $$(sel + ' button').forEach(b => b.classList.toggle('is-on', b.dataset.v === val));
}
function bindSeg(sel, key) {
  $(sel).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const cur = state.draft.v[key];
    const next = (key === 'again' && cur === b.dataset.v) ? '' : b.dataset.v;
    state.draft.v[key] = next;
    setSeg(sel, next);
  });
}
bindSeg('#f-type', 'type');
bindSeg('#f-again', 'again');

['date', 'place', 'area', 'mood', 'memo'].forEach(k => {
  $('#f-' + k).addEventListener('input', e => {
    if (!state.draft) return;
    state.draft.v[k] = e.target.value;
    if (k === 'date') state.draft.dateTouched = true;
  });
});

/* 칩 묶음 (분위기·향미 공용) */
function chipsHTML(options, selected, cls) {
  const all = [...options, ...selected.filter(s => !options.includes(s))];
  return all.map(o => `<button type="button" class="chip ${cls} ${cls === 'flavor' ? 'fl-' + famOf(o) : ''} ${selected.includes(o) ? 'is-on' : ''}" data-chip="${esc(o)}">${esc(o)}</button>`).join('')
    + `<button type="button" class="chip add" data-chip-add>+ 직접 입력</button>`;
}
function handleChips(container, getArr, rerender) {
  container.addEventListener('click', e => {
    const add = e.target.closest('[data-chip-add]');
    if (add) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'chip-input';
      inp.placeholder = '입력 후 완료';
      inp.enterKeyHint = 'done';
      add.replaceWith(inp);
      inp.focus();
      const commit = () => {
        const val = inp.value.trim();
        if (val && !getArr().includes(val)) getArr().push(val);
        rerender();
      };
      inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
      inp.addEventListener('blur', commit, { once: true });
      return;
    }
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    const arr = getArr();
    const i = arr.indexOf(c.dataset.chip);
    if (i >= 0) arr.splice(i, 1); else arr.push(c.dataset.chip);
    c.classList.toggle('is-on', i < 0);
  });
}

function renderMoodTags() {
  const v = state.draft.v;
  v.scales = v.scales || {};
  $('#f-mood-scales').innerHTML = MOOD_SCALES.map(s => `<div class="scale" data-scale="${s.k}">
    <span class="scale-lo">${s.lo}</span>
    <span class="scale-dots" role="radiogroup" aria-label="${s.lo}에서 ${s.hi}">${[1, 2, 3, 4, 5].map(n => `<button type="button" role="radio" aria-checked="${v.scales[s.k] === n}" class="${v.scales[s.k] === n ? 'on' : ''}" data-n="${n}" aria-label="${n}"></button>`).join('')}</span>
    <span class="scale-hi">${s.hi}</span>
  </div>`).join('');
  const extra = v.moodTags.filter(t => !MOOD_INTERIOR.includes(t) && !MOOD_GOOD.includes(t));
  const chip = t => `<button type="button" class="chip ${v.moodTags.includes(t) ? 'is-on' : ''}" data-chip="${esc(t)}">${esc(t)}</button>`;
  $('#f-mood-interior').innerHTML = MOOD_INTERIOR.map(chip).join('');
  $('#f-mood-good').innerHTML = [...MOOD_GOOD, ...extra].map(chip).join('') + `<button type="button" class="chip add" data-chip-add>+ 직접</button>`;
}
$('#f-mood-scales').addEventListener('click', e => {
  const b = e.target.closest('[data-n]');
  if (!b) return;
  const k = b.closest('[data-scale]').dataset.scale;
  const n = Number(b.dataset.n);
  const sc = state.draft.v.scales;
  sc[k] = sc[k] === n ? 0 : n;
  renderMoodTags();
});
handleChips($('#f-mood-interior'), () => state.draft.v.moodTags, renderMoodTags);
handleChips($('#f-mood-good'), () => state.draft.v.moodTags, renderMoodTags);

/* 사진 */
function renderPhotos() {
  const { v, newBlobs } = state.draft;
  const g = $('#f-photos');
  g.innerHTML = v.photos.map(p => `<div class="ph" data-ph="${esc(p.id)}">
    <img ${newBlobs.has(p.id) ? `src="${newBlobs.get(p.id).url}"` : `data-pid="${esc(p.id)}"`} alt="">
    <button type="button" class="ph-x" data-ph-del aria-label="사진 빼기">×</button>
    <button type="button" class="ph-label ${p.label === '안내지' ? 'is-flyer' : ''}" data-ph-label>${esc(p.label || '공간')}</button>
  </div>`).join('');
  hydrateImages(g);
}
$('#f-photo-input').addEventListener('change', async e => {
  const files = await takeFiles(e.target);
  if (!files.length) return;
  toast(files.length > 1 ? `사진 ${files.length}장 준비 중…` : '사진 준비 중…');
  const d0 = state.draft;
  if (d0 && d0.isNew && !d0.dateTouched) {
    for (const f of files) {
      const ds = await exifDate(f);
      if (ds) {
        d0.v.date = ds;
        $('#f-date').value = ds;
        d0.dateTouched = true;
        if (ds !== today()) setTimeout(() => toast(`사진 찍은 날(${fmtDate(ds)})로 날짜를 맞췄어요`), 900);
        break;
      }
    }
  }
  for (const f of files) {
    try {
      const blob = await shrink(f);
      const id = uid();
      state.draft.newBlobs.set(id, { blob, url: URL.createObjectURL(blob) });
      state.draft.v.photos.push({ id, label: state.draft.v.photos.length === 0 ? '공간' : '메뉴' });
    } catch (err) {
      toast('읽을 수 없는 사진이 있어 건너뛰었어요');
    }
  }
  renderPhotos();
});
$('#f-photos').addEventListener('click', e => {
  const wrap = e.target.closest('[data-ph]');
  if (!wrap) return;
  const id = wrap.dataset.ph;
  const d = state.draft;
  if (e.target.closest('[data-ph-del]')) {
    d.v.photos = d.v.photos.filter(p => p.id !== id);
    if (d.newBlobs.has(id)) { URL.revokeObjectURL(d.newBlobs.get(id).url); d.newBlobs.delete(id); }
    else d.removed.push(id);
    renderPhotos();
  } else if (e.target.closest('[data-ph-label]')) {
    const p = d.v.photos.find(x => x.id === id);
    p.label = PHOTO_LABELS[(PHOTO_LABELS.indexOf(p.label) + 1) % PHOTO_LABELS.length];
    renderPhotos();
  }
});

/* 메뉴 항목 */
/* 편집 화면에서만 쓰는 펼침 상태 (저장 안 함) */
const itemUI = new Map(); // itemId -> { fam, info, feel }
const uiOf = id => { if (!itemUI.has(id)) itemUI.set(id, { fam: null, info: false, feel: false }); return itemUI.get(id); };
const FAM_LABEL = { fruit: '과일', floral: '꽃', sweet: '단맛', roast: '고소함', tea: '차·허브' };

function flavorPickerHTML(it) {
  const ui = uiOf(it.id);
  const sel = it.flavors || [];
  const picked = sel.length
    ? `<div class="flv-picked">${sel.map(f => `<button type="button" class="chip flavor is-on fl-${famOf(f)}" data-flv="${esc(f)}" aria-label="${esc(f)} 빼기">${esc(f)}<span class="x" aria-hidden="true">×</span></button>`).join('')}</div>`
    : '<p class="hint flv-empty">아래 묶음을 눌러 향미를 골라요.</p>';
  const fams = Object.keys(FAM_LABEL).map(k => {
    const n = sel.filter(f => famOf(f) === k).length;
    return `<button type="button" class="fam-btn fam-${k} ${ui.fam === k ? 'is-open' : ''}" data-fam="${k}" aria-expanded="${ui.fam === k}">${FAM_LABEL[k]}${n ? `<b>${n}</b>` : ''}</button>`;
  }).join('') + `<button type="button" class="fam-btn ${ui.fam === 'custom' ? 'is-open' : ''}" data-fam="custom" aria-expanded="${ui.fam === 'custom'}">직접</button>`;
  let panel = '';
  if (ui.fam === 'custom') {
    panel = `<div class="fam-panel"><input type="text" class="chip-input" data-flv-custom id="i-${it.id}-flv" placeholder="예: 베르가못" enterkeyhint="done"><button type="button" class="mini-btn" data-flv-custom-add>추가</button></div>`;
  } else if (ui.fam) {
    panel = `<div class="fam-panel chips">${FLAVOR_FAMILY[ui.fam].map(f => `<button type="button" class="chip flavor fl-${ui.fam} ${sel.includes(f) ? 'is-on' : ''}" data-flv="${esc(f)}">${esc(f)}</button>`).join('')}</div>`;
  }
  return `<div class="field flv"><span class="lbl">향미</span>${picked}<div class="fam-row">${fams}</div>${panel}</div>`;
}

function itemEditHTML(it, idx) {
  const isCoffee = it.kind === 'filter' || it.kind === 'espresso';
  const b = it.bean || {};
  const ui = uiOf(it.id);
  const ph = { filter: '예: 이달의 커피, 게이샤 핸드드립', espresso: '예: 플랫화이트', drink: '예: 유자 에이드', bakery: '예: 소금빵' }[it.kind];
  const opt = (arr, cur) => arr.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${o ? esc(o) : '선택 안 함'}</option>`).join('');
  const slider = (key, label) => `<label class="slider-row"><span>${label}</span>
      <input type="range" min="0" max="5" step="1" value="${it[key] || 0}" data-k="${key}" id="i-${it.id}-${key}">
      <output>${it[key] || '-'}</output></label>`;
  let html = `<div class="item" data-item="${idx}">
    <div class="item-head">
      <span class="pill ${isCoffee ? 'bean' : ''} item-kind kind-${it.kind}">${esc(KINDS[it.kind].short)}</span>
      <input type="text" value="${esc(it.name)}" placeholder="${ph}" data-k="name" id="i-${it.id}-name" aria-label="메뉴 이름">
      <button type="button" class="item-del" data-item-del aria-label="이 항목 빼기">×</button>
    </div>
    <div class="stars" role="group" aria-label="별점">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star ${it.rating >= n ? 'is-on' : ''}" data-star="${n}" aria-label="${n}점">
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor"/></svg></button>`).join('')}</div>`;
  if (isCoffee) {
    html += `<div class="bean-box">
      <label class="field"><span class="lbl">원두 이름</span>
        <input type="text" value="${esc(b.name)}" data-b="name" id="i-${it.id}-bname" placeholder="안내지에 적힌 이름 그대로"></label>
      ${flavorPickerHTML(it)}`;
    if (it.kind === 'filter') {
      const infoSum = [b.origin, b.process, b.variety].filter(Boolean).join(' · ');
      const feelSum = [['산미', it.acidity], ['단맛', it.sweetness], ['바디', it.body]].filter(([, x]) => x).map(([l, x]) => `${l} ${x}`).join(' · ');
      html += `<details class="more" data-more="info" ${ui.info ? 'open' : ''}>
        <summary><span>원두 자세히</span><em>${esc(infoSum || '산지 · 가공 · 품종 · 로스터리')}</em></summary>
        <div class="more-body">
          <div class="row2">
            <label class="field"><span class="lbl">산지</span><input type="text" value="${esc(b.origin)}" data-b="origin" id="i-${it.id}-origin" placeholder="에티오피아 구지"></label>
            <label class="field"><span class="lbl">가공</span><select data-b="process" id="i-${it.id}-process">${opt(PROCESSES, b.process)}</select></label>
          </div>
          <div class="row2">
            <label class="field"><span class="lbl">품종</span><input type="text" value="${esc(b.variety)}" data-b="variety" id="i-${it.id}-variety" placeholder="게이샤, 버번…"></label>
            <label class="field"><span class="lbl">농장·생산자</span><input type="text" value="${esc(b.farm)}" data-b="farm" id="i-${it.id}-farm"></label>
          </div>
          <div class="row2">
            <label class="field"><span class="lbl">로스터리</span><input type="text" value="${esc(b.roaster)}" data-b="roaster" id="i-${it.id}-roaster" placeholder="카페와 다르면"></label>
            <label class="field"><span class="lbl">추출</span><select data-b="brew" id="i-${it.id}-brew">${opt(BREWS, b.brew)}</select></label>
          </div>
        </div>
      </details>
      <details class="more" data-more="feel" ${ui.feel ? 'open' : ''}>
        <summary><span>맛의 느낌</span><em>${esc(feelSum || '산미 · 단맛 · 바디')}</em></summary>
        <div class="more-body">${slider('acidity', '산미')}${slider('sweetness', '단맛')}${slider('body', '바디')}</div>
      </details>`;
    }
    html += `</div>`;
  }
  html += `<label class="field"><span class="lbl">맛 메모 <em>선택</em></span>
      <textarea rows="2" data-k="note" id="i-${it.id}-note" placeholder="${isCoffee ? '첫 모금, 식으면서 달라진 점…' : '식감, 단맛, 같이 먹은 조합…'}">${esc(it.note)}</textarea></label>
  </div>`;
  return html;
}

function renderItems() {
  const box = $('#f-items');
  const items = state.draft.v.items;
  box.innerHTML = items.map(itemEditHTML).join('');
  $('#items-hint').hidden = items.length > 0;
  $('.add-row').classList.toggle('is-start', items.length === 0);
}

/* 펼침 상태 기억 */
$('#f-items').addEventListener('toggle', e => {
  const d = e.target.closest('details[data-more]');
  const wrap = e.target.closest('[data-item]');
  if (!d || !wrap) return;
  const it = state.draft.v.items[Number(wrap.dataset.item)];
  uiOf(it.id)[d.dataset.more] = d.open;
}, true);

/* 향미 고르기 */
function addCustomFlavor(wrap) {
  const it = state.draft.v.items[Number(wrap.dataset.item)];
  const inp = $('[data-flv-custom]', wrap);
  const v = (inp?.value || '').trim();
  if (v && !it.flavors.includes(v)) it.flavors.push(v);
  renderItems();
  $(`[data-item="${wrap.dataset.item}"] [data-flv-custom]`)?.focus();
}
$('#f-items').addEventListener('click', e => {
  const wrap = e.target.closest('[data-item]');
  if (!wrap) return;
  const it = state.draft.v.items[Number(wrap.dataset.item)];
  const fam = e.target.closest('[data-fam]');
  if (fam) {
    const ui = uiOf(it.id);
    ui.fam = ui.fam === fam.dataset.fam ? null : fam.dataset.fam;
    renderItems();
    if (ui.fam === 'custom') $(`[data-item="${wrap.dataset.item}"] [data-flv-custom]`)?.focus();
    return;
  }
  const f = e.target.closest('[data-flv]');
  if (f) {
    const i = it.flavors.indexOf(f.dataset.flv);
    if (i >= 0) it.flavors.splice(i, 1); else it.flavors.push(f.dataset.flv);
    renderItems();
    return;
  }
  if (e.target.closest('[data-flv-custom-add]')) addCustomFlavor(wrap);
});
$('#f-items').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-flv-custom]')) {
    e.preventDefault();
    addCustomFlavor(e.target.closest('[data-item]'));
  }
});
$('#f-items').addEventListener('input', e => {
  const wrap = e.target.closest('[data-item]');
  if (!wrap) return;
  const it = state.draft.v.items[Number(wrap.dataset.item)];
  if (e.target.dataset.k) {
    const k = e.target.dataset.k;
    it[k] = e.target.type === 'range' ? Number(e.target.value) : e.target.value;
    if (e.target.type === 'range') e.target.nextElementSibling.textContent = it[k] || '-';
  } else if (e.target.dataset.b) {
    it.bean[e.target.dataset.b] = e.target.value;
  }
});
$('#f-items').addEventListener('change', e => {
  if (e.target.tagName === 'SELECT' && e.target.dataset.b) {
    const it = state.draft.v.items[Number(e.target.closest('[data-item]').dataset.item)];
    it.bean[e.target.dataset.b] = e.target.value;
  }
});
$('#f-items').addEventListener('click', e => {
  const wrap = e.target.closest('[data-item]');
  if (!wrap) return;
  const idx = Number(wrap.dataset.item);
  const it = state.draft.v.items[idx];
  const star = e.target.closest('[data-star]');
  if (star) {
    const n = Number(star.dataset.star);
    it.rating = it.rating === n ? 0 : n;
    $$('.star', wrap).forEach((s, i) => s.classList.toggle('is-on', i < it.rating));
  } else if (e.target.closest('[data-item-del]')) {
    state.draft.v.items.splice(idx, 1);
    renderItems();
  }
});
$$('[data-add]').forEach(b => b.addEventListener('click', () => {
  state.draft.v.items.push(blankItem(b.dataset.add));
  renderItems();
  const last = $('#f-items').lastElementChild;
  if (last) { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('input[data-k=name]', last)?.focus({ preventScroll: true }); }
}));

/* 저장 */
function cleanItem(it) {
  const out = { ...it, name: (it.name || '').trim(), note: (it.note || '').trim() };
  if (out.bean) {
    Object.keys(out.bean).forEach(k => { out.bean[k] = (out.bean[k] || '').trim(); });
    if (!out.name && out.bean.name) out.name = '';
  }
  return out;
}
function isEmptyItem(it) {
  const b = it.bean || {};
  return !it.name && !it.note && !it.rating && !Object.values(b).some(x => x && x !== '핸드드립') && !(it.flavors || []).length;
}

$('#btn-save').addEventListener('click', async () => {
  const d = state.draft;
  if (!d) return;
  const v = d.v;
  v.place = (v.place || '').trim();
  if (!v.place) {
    toast('카페 이름을 적어주세요');
    $('#f-place').focus();
    return;
  }
  v.items = v.items.map(cleanItem).filter(it => !isEmptyItem(it));
  v.area = (v.area || '').trim();
  v.mood = (v.mood || '').trim();
  v.memo = (v.memo || '').trim();
  v.updatedAt = Date.now();
  const add = v.photos.filter(p => d.newBlobs.has(p.id)).map(p => ({ id: p.id, visitId: v.id, blob: d.newBlobs.get(p.id).blob }));
  try {
    await store.saveVisit(v, add, d.removed);
  } catch (err) {
    toast('저장하지 못했어요. 저장 공간이 부족한지 확인해 주세요.');
    return;
  }
  d.newBlobs.forEach(x => URL.revokeObjectURL(x.url));
  d.removed.forEach(dropURL);
  if (d.fromWish) {
    const w = state.wishes.find(x => x.id === d.fromWish);
    if (w) { w.visitedId = v.id; w.visitedAt = v.date; await store.saveWish(w, [], []); }
  }
  askPersist();
  await load();
  state.draft = null;
  state.currentId = v.id;
  toast('저장했어요');
  history.replaceState({ view: 'detail', id: v.id }, '');
  route({ view: 'detail', id: v.id });
});

$('#btn-cancel').addEventListener('click', () => {
  const d = state.draft;
  if (d) d.newBlobs.forEach(x => URL.revokeObjectURL(x.url));
  state.draft = null;
  back();
});

$('#btn-delete').addEventListener('click', () => {
  $('#delete-confirm').hidden = false;
  $('#btn-delete').hidden = true;
});
$('#btn-delete-no').addEventListener('click', () => {
  $('#delete-confirm').hidden = true;
  $('#btn-delete').hidden = false;
});
$('#btn-delete-yes').addEventListener('click', async () => {
  const src = state.visits.find(x => x.id === state.draft.v.id);
  if (src) {
    await store.deleteVisit(src);
    (src.photos || []).forEach(p => dropURL(p.id));
  }
  await load();
  state.draft = null;
  toast('삭제했어요');
  if (window.JANLOG_PREVIEW && !state.visits.length) await addSample(true);
  history.replaceState({ view: 'home' }, '');
  route({ view: 'home' });
});

/* =========================================================
   가볼 곳 (위시리스트)
   ========================================================= */
const mapLinks = w => {
  const q = encodeURIComponent([w.area, w.name].filter(Boolean).join(' '));
  return {
    kakao: `https://map.kakao.com/?q=${q}`,
    naver: `https://map.naver.com/p/search/${q}`,
  };
};

function wishCardHTML(w) {
  const m = mapLinks(w);
  const sub = [w.area, w.memo].filter(Boolean).map(esc).join(' · ');
  return `<div class="wish-row">
    <button type="button" class="wish-main" data-wish-open="${esc(w.id)}">
      <span class="wish-name">${esc(w.name)}${w.type === '베이커리' ? '<span class="wish-kind">베이커리</span>' : ''}</span>
      ${sub ? `<span class="wish-sub">${sub}</span>` : ''}
    </button>
    <div class="wish-links">
      <a href="${m.kakao}" target="_blank" rel="noopener">카카오맵</a>
      <a href="${m.naver}" target="_blank" rel="noopener">네이버지도</a>
    </div>
    <button type="button" class="mini-btn go" data-wish-go="${esc(w.id)}">다녀왔어요</button>
  </div>`;
}

function renderWishes() {
  const q = state.q.trim().toLowerCase();
  const match = w => !q || [w.name, w.area, w.memo].filter(Boolean).join(' ').toLowerCase().includes(q);
  const todo = state.wishes.filter(w => !w.visitedId && match(w));
  const done = state.wishes.filter(w => w.visitedId && match(w));
  if (!state.wishes.length) {
    return `<div class="empty-state">${CUP_SVG}
      <h2>가보고 싶은 곳을 모아둘까요</h2>
      <p>인스타에서 본 카페를 캡처해서 넣으면, 사진 속 글자를 읽어 가게 이름과 동네를 톡톡 눌러 채울 수 있어요.</p>
      <div class="stack" style="max-width:260px;margin:22px auto 0"><button class="primary-btn" data-act="wish-new">가볼 곳 추가</button></div>
    </div>`;
  }
  let html = `<h2 class="month">가볼 곳 ${todo.length}</h2>`;
  html += todo.length ? `<div class="wish-list">${todo.map(wishCardHTML).join('')}</div>` : '<p class="cal-empty">다 가봤어요! 새로 가볼 곳을 추가해 보세요.</p>';
  if (done.length) {
    html += `<h2 class="month">다녀온 곳 ${done.length}</h2><div class="done-list">${done.map(w => `
      <button type="button" class="place-row" ${w.visitedId && state.visits.some(v => v.id === w.visitedId) ? `data-open="${esc(w.visitedId)}"` : `data-wish-open="${esc(w.id)}"`}>
        <span class="place-name">${esc(w.name)}</span>
        <span class="place-type">${esc(w.area || '')}</span>
        <span class="place-count">${w.visitedAt ? fmtDate(w.visitedAt) + ' 방문' : '방문함'}</span>
      </button>`).join('')}</div>`;
  }
  return html;
}

$('#home-body').addEventListener('click', e => {
  const open = e.target.closest('[data-wish-open]');
  if (open) { state.wishDraft = null; return go('wish', { id: open.dataset.wishOpen }); }
  const goBtn = e.target.closest('[data-wish-go]');
  if (goBtn) return visitFromWish(goBtn.dataset.wishGo);
  if (e.target.closest('[data-act="wish-new"]')) { state.wishDraft = null; return go('wish'); }
});

function visitFromWish(id) {
  const w = state.wishes.find(x => x.id === id);
  if (!w) return;
  state.draft = null;
  startDraft();
  Object.assign(state.draft.v, { place: w.name || '', area: w.area || '', type: w.type || '카페' });
  state.draft.fromWish = w.id;
  go('edit');
  toast('가볼 곳 정보를 채워뒀어요');
}

function startWishDraft(id) {
  const src = id ? state.wishes.find(w => w.id === id) : null;
  state.wishDraft = src
    ? { w: { ...JSON.parse(JSON.stringify(src)), photos: (src.photos || []).map(p => ({ ...p })) }, isNew: false, newBlobs: new Map(), removed: [], target: 'name', tokens: [] }
    : { w: { id: uid(), name: '', area: '', type: '카페', memo: '', photos: [], createdAt: Date.now() }, isNew: true, newBlobs: new Map(), removed: [], target: 'name', tokens: [] };
}

function renderWishEdit() {
  const d = state.wishDraft;
  const w = d.w;
  $('#wish-title').textContent = d.isNew ? '가볼 곳 추가' : '가볼 곳';
  ['name', 'area', 'memo'].forEach(k => { $('#w-' + k).value = w[k] || ''; });
  setSeg('#w-type', w.type || '카페');
  setSeg('#ocr-target', d.target);
  $('#ocr-status').textContent = '';
  $('#ocr-status').classList.remove('busy');
  renderWishPhotos();
  renderOcrChips();
  renderWishMaps();
  $('#wish-delete-zone').hidden = d.isNew;
  $('#wish-delete-confirm').hidden = true;
  $('#btn-wish-delete').hidden = false;
  $('#wish-visited-line').hidden = !w.visitedId;
  if (w.visitedId) $('#wish-visited-line').textContent = `${w.visitedAt ? fmtDateLong(w.visitedAt) + '에 ' : ''}다녀왔어요.`;
}

function renderWishPhotos() {
  const { w, newBlobs } = state.wishDraft;
  const g = $('#w-photos');
  g.innerHTML = w.photos.map(p => `<div class="ph" data-ph="${esc(p.id)}">
    <img ${newBlobs.has(p.id) ? `src="${newBlobs.get(p.id).url}"` : `data-pid="${esc(p.id)}"`} alt="">
    <button type="button" class="ph-x" data-ph-del aria-label="사진 빼기">×</button>
    <button type="button" class="ph-label" data-ph-ocr>글자 읽기</button>
  </div>`).join('');
  hydrateImages(g);
}

function renderWishMaps() {
  const w = state.wishDraft.w;
  const box = $('#w-maps');
  if (!w.name.trim()) { box.innerHTML = '<span class="hint">이름을 넣으면 지도에서 바로 찾아볼 수 있어요.</span>'; return; }
  const m = mapLinks(w);
  box.innerHTML = `<a class="mini-btn" href="${m.kakao}" target="_blank" rel="noopener">카카오맵에서 찾기</a>
    <a class="mini-btn" href="${m.naver}" target="_blank" rel="noopener">네이버지도에서 찾기</a>`;
}

['name', 'area', 'memo'].forEach(k => {
  $('#w-' + k).addEventListener('input', e => {
    if (!state.wishDraft) return;
    state.wishDraft.w[k] = e.target.value;
    if (k === 'name' || k === 'area') renderWishMaps();
  });
});
$('#w-type').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !state.wishDraft) return;
  state.wishDraft.w.type = b.dataset.v;
  setSeg('#w-type', b.dataset.v);
});
$('#ocr-target').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !state.wishDraft) return;
  state.wishDraft.target = b.dataset.v;
  setSeg('#ocr-target', b.dataset.v);
});

$('#w-photo-input').addEventListener('change', async e => {
  const files = await takeFiles(e.target);
  if (!files.length || !state.wishDraft) return;
  const d = state.wishDraft;
  const added = [];
  for (const f of files) {
    try {
      const blob = await shrink(f);
      const id = uid();
      d.newBlobs.set(id, { blob, url: URL.createObjectURL(blob), src: f });
      d.w.photos.push({ id, label: '캡처' });
      added.push({ id, file: f });
    } catch { toast('읽을 수 없는 사진이 있어 건너뛰었어요'); }
  }
  renderWishPhotos();
  for (const a of added) await readTextInto(a.file);
});

$('#w-photos').addEventListener('click', async e => {
  const wrap = e.target.closest('[data-ph]');
  if (!wrap) return;
  const id = wrap.dataset.ph;
  const d = state.wishDraft;
  if (e.target.closest('[data-ph-del]')) {
    d.w.photos = d.w.photos.filter(p => p.id !== id);
    if (d.newBlobs.has(id)) { URL.revokeObjectURL(d.newBlobs.get(id).url); d.newBlobs.delete(id); }
    else d.removed.push(id);
    renderWishPhotos();
  } else if (e.target.closest('[data-ph-ocr]')) {
    const nb = d.newBlobs.get(id);
    const blob = nb ? (nb.src || nb.blob) : (await store.photo(id))?.blob;
    if (blob) readTextInto(blob);
  }
});

/* 사진 속 글자 읽기 — 이 기기 안에서 Tesseract로 처리 */
const OCR_LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let ocrWorkerP = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('script'));
    document.head.appendChild(s);
  });
}
function ocrStatus(msg, busy) {
  const el = $('#ocr-status');
  if (msg) $('#ocr-box').hidden = false;
  el.textContent = msg;
  el.classList.toggle('busy', !!busy);
}
/* OCR에 넣기 전에 사진 크기 줄이기: 카메라 원본(1200만 화소 이상)을 그대로 넣으면 폰 메모리가 모자라 멈춘다 */
async function ocrPrep(blob) {
  try {
    const src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const k = Math.min(1, 2400 / Math.max(src.width, src.height), Math.sqrt(3000000 / (src.width * src.height)));
    // 크기가 작아도 한 번 다시 그려서 새 파일로 만든다 (원본 파일을 다시 읽지 않게)
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))) || blob;
  } catch { return blob; }
}
// 실패하면 원인을 짧게 함께 보여준다 (다음에 고칠 때 단서)
const ocrFailMsg = err => (navigator.onLine === false
  ? '인터넷이 연결되지 않았어요. 글자 읽기는 처음 한 번 인터넷이 필요해요.'
  : '글자를 읽지 못했어요. 한 번 더 눌러보거나 직접 입력해 주세요.') + (err && err.message ? ` (${String(err.message).slice(0, 60)})` : '');
async function getOcrWorker() {
  if (!ocrWorkerP) {
    ocrWorkerP = (async () => {
      await loadScript(OCR_LIB);
      if (!window.Tesseract) throw new Error('lib');
      return window.Tesseract.createWorker(['kor', 'eng'], 1, {
        logger: m => {
          if (!m || typeof m.progress !== 'number') return;
          const pct = Math.round(m.progress * 100);
          if (m.status && m.status.includes('recogniz')) ocrStatus(`글자 읽는 중… ${pct}%`, true);
          else ocrStatus(`글자 인식 준비 중… ${pct}% (처음 한 번만 오래 걸려요)`, true);
        },
      });
    })();
    ocrWorkerP = ocrWorkerP.then(w => {
      // 인식 중 오류가 나면 작업자를 버리고 다음에 새로 만든다
      const orig = w.recognize.bind(w);
      w.recognize = async (img, ...rest) => {
        try { return await orig(await ocrPrep(img), ...rest); }
        catch (e) { ocrWorkerP = null; try { w.terminate(); } catch {} throw e; }
      };
      return w;
    });
    ocrWorkerP.catch(() => { ocrWorkerP = null; });
  }
  return ocrWorkerP;
}

const AREA_WORDS = ['전포', '서면', '광안리', '광안', '해운대', '송정', '기장', '영도', '남포', '중앙동', '부산대', '동래', '온천장',
  '연산', '수영', '민락', '센텀', '대연', '경성대', '망미', '해리단길', '전리단길', '흰여울', '청사포', '달맞이', '화명', '덕천', '사직',
  '성수', '연남', '망원', '합정', '을지로', '익선', '한남', '이태원', '서촌', '북촌', '삼청', '문래', '연희', '용산', '압구정', '가로수길', '성수동'];
const isAreaGuess = t => AREA_WORDS.includes(t) || /^[가-힣]{1,5}(동|역|로|길|구)$/.test(t);

function tokenize(text) {
  const clean = s => s.replace(/[^가-힣A-Za-z0-9@#&'._\- ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.\-_ ]+$/, '');
  const lines = text.split(/\n+/).map(clean).filter(l => l.length >= 2 && l.length <= 22);
  const words = text.split(/[\s,·|/]+/).map(clean).filter(w => w.length >= 2 && w.length <= 16 && !/^\d+$/.test(w));
  const seen = new Set(), out = [];
  [...lines, ...words].forEach(t => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } });
  return out.slice(0, 60);
}

async function readTextInto(blob) {
  const d = state.wishDraft;
  if (!d) return;
  ocrStatus('글자 인식 준비 중…', true);
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(blob);
    const toks = tokenize((data && data.text) || '');
    if (state.wishDraft !== d) return;
    const known = new Set(d.tokens.map(t => t.toLowerCase()));
    toks.forEach(t => { if (!known.has(t.toLowerCase())) d.tokens.push(t); });
    renderOcrChips();
    ocrStatus(toks.length ? '찾은 글자예요. 눌러서 채우세요.' : '글자를 찾지 못했어요. 직접 입력해 주세요.');
  } catch (err) {
    ocrStatus(ocrFailMsg(err));
  }
}

function renderOcrChips() {
  const d = state.wishDraft;
  const box = $('#ocr-chips');
  $('#ocr-box').hidden = !d.tokens.length && !$('#ocr-status').textContent;
  box.innerHTML = d.tokens.map(t => `<button type="button" class="chip ocr-chip ${isAreaGuess(t) ? 'area-guess' : ''}" data-tok="${esc(t)}">${esc(t)}</button>`).join('');
}

$('#ocr-chips').addEventListener('click', e => {
  const c = e.target.closest('[data-tok]');
  const d = state.wishDraft;
  if (!c || !d) return;
  const t = c.dataset.tok;
  const w = d.w;
  if (d.target === 'name') {
    w.name = t;
    d.target = 'area';
    setSeg('#ocr-target', 'area');
    toast(`가게 이름: ${t}`);
  } else if (d.target === 'area') {
    w.area = w.area && !w.area.includes(t) ? `${w.area} ${t}` : t;
    toast(`위치: ${w.area}`);
  } else {
    w.memo = w.memo ? `${w.memo}\n${t}` : t;
  }
  c.classList.add('used');
  ['name', 'area', 'memo'].forEach(k => { $('#w-' + k).value = w[k] || ''; });
  renderWishMaps();
});

$('#btn-wish-save').addEventListener('click', async () => {
  const d = state.wishDraft;
  if (!d) return;
  const w = d.w;
  w.name = (w.name || '').trim();
  if (!w.name) { toast('가게 이름을 적어주세요'); $('#w-name').focus(); return; }
  ['area', 'memo'].forEach(k => { w[k] = (w[k] || '').trim(); });
  w.updatedAt = Date.now();
  const add = w.photos.filter(p => d.newBlobs.has(p.id)).map(p => ({ id: p.id, visitId: w.id, blob: d.newBlobs.get(p.id).blob }));
  try { await store.saveWish(w, add, d.removed); }
  catch { toast('저장하지 못했어요. 저장 공간이 부족한지 확인해 주세요.'); return; }
  d.newBlobs.forEach(x => URL.revokeObjectURL(x.url));
  d.removed.forEach(dropURL);
  askPersist();
  await load();
  state.wishDraft = null;
  state.tab = 'wish';
  toast('가볼 곳에 담았어요');
  history.replaceState({ view: 'home' }, '');
  route({ view: 'home' });
});
$('#btn-wish-cancel').addEventListener('click', () => {
  const d = state.wishDraft;
  if (d) d.newBlobs.forEach(x => URL.revokeObjectURL(x.url));
  state.wishDraft = null;
  back();
});
$('#btn-wish-delete').addEventListener('click', () => { $('#wish-delete-confirm').hidden = false; $('#btn-wish-delete').hidden = true; });
$('#btn-wish-delete-no').addEventListener('click', () => { $('#wish-delete-confirm').hidden = true; $('#btn-wish-delete').hidden = false; });
$('#btn-wish-delete-yes').addEventListener('click', async () => {
  const src = state.wishes.find(x => x.id === state.wishDraft.w.id);
  if (src) { await store.deleteWish(src); (src.photos || []).forEach(p => dropURL(p.id)); }
  await load();
  state.wishDraft = null;
  toast('삭제했어요');
  history.replaceState({ view: 'home' }, '');
  route({ view: 'home' });
});

/* ---------- 사진 촬영일 읽기 (JPEG EXIF) ---------- */
async function exifDate(file) {
  try {
    if (!file || !/jpe?g/i.test(file.type || '')) return null;
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {
        const t = off + 10;
        const le = v.getUint16(t) === 0x4949;
        const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
        const readIfd = (ifd, want) => {
          const n = u16(t + ifd);
          for (let i = 0; i < n; i++) {
            const e = t + ifd + 2 + i * 12;
            if (u16(e) === want) return e;
          }
          return -1;
        };
        const readStr = e => {
          const cnt = u32(e + 4), p = t + u32(e + 8);
          let s = '';
          for (let i = 0; i < cnt - 1 && p + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(p + i));
          return s;
        };
        const ifd0 = u32(t + 4);
        let str = '';
        const exifPtr = readIfd(ifd0, 0x8769);
        if (exifPtr >= 0) {
          const e = readIfd(u32(exifPtr + 8), 0x9003);
          if (e >= 0) str = readStr(e);
        }
        if (!str) { const e = readIfd(ifd0, 0x0132); if (e >= 0) str = readStr(e); }
        const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(str);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + len;
    }
  } catch { /* 읽을 수 없는 사진 */ }
  return null;
}

/* ---------- 저장 공간 ---------- */
async function askPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* 지원 안 함 */ }
}

const FONT_KEY = 'janlog.font';
function renderFonts() {
  const cur = document.documentElement.getAttribute('data-font') || 'plex';
  const fonts = window.JANLOG_FONTS || {};
  $('#font-list').innerHTML = Object.entries(fonts).map(([k, f]) => `
    <button type="button" class="font-opt ${k === cur ? 'is-on' : ''}" data-font="${k}" aria-pressed="${k === cur}">
      <span class="font-dot" aria-hidden="true"></span>
      <span><span class="font-name">${esc(f.name)} · ${esc(f.note)}</span>
      <span class="font-sample" style="font-family:${f.family ? `'${f.family}', ` : ''}var(--f-sys)">자스민 향이 나는 이달의 커피 4.5점</span></span>
    </button>`).join('');
}
$('#font-list').addEventListener('click', e => {
  const b = e.target.closest('[data-font]');
  if (!b || !window.applyFont) return;
  const k = window.applyFont(b.dataset.font);
  lsSet(FONT_KEY, k);
  renderFonts();
});
// 미리보기 줄에 쓰려고 고를 수 있는 글꼴을 모두 불러둔다
function preloadFontSamples() {
  Object.values(window.JANLOG_FONTS || {}).forEach(f => {
    if (!f.css || document.querySelector(`link[data-sample="${f.css}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = f.css; l.dataset.sample = f.css;
    document.head.appendChild(l);
  });
}

const SKIN_KEY = 'janlog.skin';
function renderSkins() {
  const cur = skin();
  $('#skin-list').innerHTML = Object.entries(window.JANLOG_SKINS || {}).map(([k, s]) => `
    <button type="button" class="font-opt skin-opt ${k === cur ? 'is-on' : ''}" data-skin-pick="${k}" aria-pressed="${k === cur}">
      <span class="font-dot" aria-hidden="true"></span>
      <span><span class="font-sample">${esc(s.name)}</span><span class="font-name">${esc(s.note)}</span></span>
    </button>`).join('');
}
function pickSkin(k) {
  const s = window.applySkin ? window.applySkin(k) : k;
  lsSet(SKIN_KEY, s);
  document.dispatchEvent(new CustomEvent('janlog:skin', { detail: s }));
  return s;
}
$('#skin-list').addEventListener('click', e => {
  const b = e.target.closest('[data-skin-pick]');
  if (!b) return;
  pickSkin(b.dataset.skinPick);
  renderSkins();
});
document.addEventListener('janlog:rerender', () => {
  if (!$('#view-home').hidden) renderHome();
  if (!$('#view-detail').hidden) renderDetail();
  if (!$('#view-settings').hidden) { renderSkins(); renderLayouts(); }
});

const LAYOUT_KEY = 'janlog.layout';
function renderLayouts() {
  const cur = layout();
  $('#layout-list').innerHTML = Object.entries(window.JANLOG_LAYOUTS || {}).map(([k, s]) => `
    <button type="button" class="font-opt ${k === cur ? 'is-on' : ''}" data-layout-pick="${k}" aria-pressed="${k === cur}">
      <span class="font-dot" aria-hidden="true"></span>
      <span><span class="font-sample">${esc(s.name)}</span><span class="font-name">${esc(s.note)}</span></span>
    </button>`).join('');
}
$('#layout-list').addEventListener('click', e => {
  const b = e.target.closest('[data-layout-pick]');
  if (!b) return;
  const k = window.applyLayout ? window.applyLayout(b.dataset.layoutPick) : b.dataset.layoutPick;
  lsSet(LAYOUT_KEY, k);
  renderLayouts();
});

async function renderSettings() {
  preloadFontSamples();
  renderLayouts();
  renderSkins();
  renderFonts();
  const n = state.visits.length;
  const photoCount = state.visits.reduce((a, v) => a + (v.photos || []).length, 0);
  let usage = '';
  try {
    if (navigator.storage?.estimate) {
      const { usage: u } = await navigator.storage.estimate();
      if (u) usage = ` · 약 ${(u / 1048576).toFixed(1)}MB 사용`;
    }
  } catch { /* 무시 */ }
  $('#stat-line').textContent = `기록 ${n}개 · 가볼 곳 ${state.wishes.length}개 · 사진 ${photoCount}장${usage}`;
  let persisted = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { /* 무시 */ }
  $('#persist-line').textContent = persisted === true
    ? '이 기기에 오래 보관되도록 설정되어 있어요.'
    : '브라우저가 공간이 부족하면 데이터를 지울 수 있어요. 홈 화면에 추가하고 백업해 두면 안전해요.';
  const last = lsGet(BACKUP_KEY);
  $('#last-backup-line').textContent = last ? `마지막 백업: ${fmtDateLong(last)}` : '아직 백업한 적이 없어요.';
  $('#io-status').textContent = '';
}

/* ---------- 백업 ---------- */
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

$('#btn-export').addEventListener('click', async () => {
  const status = $('#io-status');
  status.textContent = '백업 파일 만드는 중…';
  try {
    const visits = await store.allVisits();
    const photos = await store.allPhotos();
    const outPhotos = [];
    for (const p of photos) outPhotos.push({ id: p.id, visitId: p.visitId, data: await blobToDataURL(p.blob) });
    const wishes = await store.allWishes();
    const payload = { app: 'janlog', version: 2, exportedAt: new Date().toISOString(), visits, wishes, photos: outPhotos };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const name = `잔잔-백업-${today()}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    let done = false;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        done = true;
      } catch (err) {
        if (err && err.name === 'AbortError') { status.textContent = '백업을 취소했어요.'; return; }
      }
    }
    if (!done) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    lsSet(BACKUP_KEY, today());
    status.textContent = `${name} (${(blob.size / 1048576).toFixed(1)}MB)을 만들었어요. 클라우드에 꼭 올려두세요.`;
    $('#last-backup-line').textContent = `마지막 백업: ${fmtDateLong(today())}`;
  } catch (err) {
    status.textContent = '백업 파일을 만들지 못했어요. 다시 시도해 주세요.';
  }
});

$('#import-input').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  const status = $('#io-status');
  status.textContent = '불러오는 중…';
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'janlog' || !Array.isArray(data.visits)) throw new Error('형식');
    const photos = [];
    for (const p of data.photos || []) photos.push({ id: p.id, visitId: p.visitId, blob: await dataURLToBlob(p.data) });
    const existing = new Set(state.visits.map(v => v.id));
    const added = data.visits.filter(v => !existing.has(v.id)).length;
    await store.putMany(data.visits, photos, Array.isArray(data.wishes) ? data.wishes : []);
    photos.forEach(p => dropURL(p.id));
    await load();
    const wn = Array.isArray(data.wishes) ? data.wishes.length : 0;
    const msg = `기록 ${data.visits.length}개${wn ? `, 가볼 곳 ${wn}개` : ''}를 불러왔어요 (새 기록 ${added}개, 같은 기록은 백업 내용으로 덮어씀).`;
    await renderSettings();
    status.textContent = msg;
  } catch (err) {
    status.textContent = '잔잔 백업 파일이 아니거나 손상된 파일이에요.';
  }
});

/* ---------- 시작 ---------- */
(async function init() {
  try {
    await load();
  } catch (err) {
    $('#home-body').innerHTML = `<div class="empty-state"><h2>저장소를 열지 못했어요</h2><p>시크릿 모드에서는 기록을 저장할 수 없어요. 일반 창에서 열어 주세요.</p></div>`;
    return;
  }
  if (window.JANLOG_PREVIEW && !state.visits.length) await addSample(true);
  history.replaceState({ view: 'home' }, '');
  route({ view: 'home' });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

/* 앱 버전 표시 (설정 맨 아래). 업데이트가 들어왔는지 확인용 */
const APP_VER = 'janlog-v23';
(() => { const el = document.getElementById('app-ver'); if (el) el.textContent = `잔잔 버전 ${APP_VER.split('-').pop()}`; })();
