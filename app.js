'use strict';
const APP_VERSION = '4';
/* ========== 共通 ========== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200); }

const FIELDS = [
  ['last', '姓'], ['first', '名'], ['yomi', '読み(ひらがな)'], ['company', '会社名'], ['dept', '部署'], ['title', '役職'],
  ['country', '国'], ['email', 'メール', 'email'], ['tel', '会社電話', 'tel'], ['mobile', '携帯電話', 'tel'], ['fax', 'FAX', 'tel'],
  ['address', '住所'], ['memo', 'メモ', 'textarea']
];

/* ========== IndexedDB(端末内のみ) ========== */
const DB = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('meishi', 1);
    r.onupgradeneeded = () => { const d = r.result; ['cards', 'images', 'thumbs'].forEach(n => d.createObjectStore(n, { keyPath: 'id' })); d.createObjectStore('settings', { keyPath: 'key' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const st = async (n, m = 'readonly') => (await open()).transaction(n, m).objectStore(n);
  const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  return {
    all: async n => rq((await st(n)).getAll()),
    get: async (n, id) => rq((await st(n)).get(id)),
    async saveCard(card, img, thumb) {
      const t = (await open()).transaction(['cards', 'images', 'thumbs'], 'readwrite');
      t.objectStore('cards').put(card);
      // iPhoneでBlobの保存が不安定なため、文字列(data URL)として保存する
      if (img) { t.objectStore('images').put({ id: card.id, url: img }); t.objectStore('thumbs').put({ id: card.id, url: thumb }); }
      return done(t);
    },
    async delCard(id) {
      const t = (await open()).transaction(['cards', 'images', 'thumbs'], 'readwrite');
      ['cards', 'images', 'thumbs'].forEach(n => t.objectStore(n).delete(id));
      return done(t);
    },
    async setting(key, def) { const r = await rq((await st('settings')).get(key)); return r ? r.value : def; },
    async setSetting(key, value) { return rq((await st('settings', 'readwrite')).put({ key, value })); }
  };
})();

/* ========== 名前・並び順 ========== */
const isJP = c => !c.country || /日本|japan|^jp$/i.test(c.country.trim());
const kata2hira = s => s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const displayName = c => ((isJP(c) ? [c.last, c.first] : [c.first, c.last]).filter(Boolean).join(' ')) || '(名前なし)';
const sortKey = c => kata2hira((isJP(c) ? (c.yomi || (c.last || '') + (c.first || '')) : (c.last || c.first || '')).toLowerCase());
const lastMet = c => (c.meetings || []).reduce((m, x) => x.date > m ? x.date : m, '');
const cmp = (a, b) => a.localeCompare(b, 'ja');

/* ========== 画像処理 ========== */
async function loadImage(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { } }
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
}
function toCanvas(img, max) {
  const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c;
}
const blobOf = r => r.blob || new Blob([r.buf], { type: r.type || 'image/jpeg' });
// OCR用: グレースケール化+コントラスト補正(明暗の幅を広げる)
function enhance(c) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  // 影や照明ムラを除く: 縮小→拡大でぼかした「背景の明るさ」で割る
  const sm = document.createElement('canvas'); sm.width = Math.max(1, W >> 4); sm.height = Math.max(1, H >> 4);
  const sg = sm.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(c, 0, 0, sm.width, sm.height);
  const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
  const bgc = bg.getContext('2d'); bgc.imageSmoothingQuality = 'high'; bgc.drawImage(sm, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H), p = d.data, b = bgc.getImageData(0, 0, W, H).data, h = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) {
    const y = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000, by = (b[i] * 299 + b[i + 1] * 587 + b[i + 2] * 114) / 1000;
    const v = Math.min(255, y * 235 / Math.max(by, 40)) | 0; p[i] = v; h[v]++;
  }
  const n = p.length / 4; let lo = 0, hi = 255, s = 0;
  for (; lo < 255 && (s += h[lo]) < n * .01; lo++);
  for (s = 0; hi > 0 && (s += h[hi]) < n * .01; hi--);
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < p.length; i += 4) { const v = Math.max(0, Math.min(255, (p[i] - lo) * k)); p[i] = p[i + 1] = p[i + 2] = v; }
  g.putImageData(d, 0, 0); return c;
}
const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

/* ========== OCR(端末内 Tesseract.js) ========== */
let worker, progressCb = () => { };
async function getWorker() {
  if (worker) return worker;
  const base = new URL('lib/', location.href).href;
  worker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
    workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', gzip: true, cacheMethod: 'none',
    logger: m => progressCb(m)
  });
  return worker;
}
async function runOCR(canvas, cb) {
  progressCb = cb;
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: '11' }); // 名刺は文字が点在するため疎なテキスト向けモード
  const { data } = await w.recognize(enhance(canvas));
  return { text: data.text || '', lines: data.lines || [] };
}

/* ========== 読み取り結果 → 項目に振り分け ========== */
function parseCard(raw, hl) {
  const CJK = '[\\u3040-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]';
  const squeeze = s => { const re = new RegExp(`(${CJK})[ \\t\\u3000]+(?=${CJK})`, 'g'); return s.replace(re, '$1'); };
  const TITLE_RE = /(部長|課長|取締役|社長|代表|主任|マネージャ|リーダー|室長|係長|所長|店長|教授|CEO|CTO|COO|CFO|President|Director|Manager|Engineer|Officer|Head|Lead|Chief|Representative|Professor)/i;
  const DEPT_RE = /(部|課|室|本部|センター|Department|Dept|Division|Team|チーム)$/i;
  const orig = [], hs = [];
  const src = hl && hl.length ? hl.map(x => ({ l: (x.text || '').trim(), h: x.bbox ? x.bbox.y1 - x.bbox.y0 : 0 })) : raw.split(/\r?\n/).map(l => ({ l: l.trim(), h: 0 }));
  src.filter(x => x.l.length > 1).forEach(({ l, h }) => {
    const push = (...a) => a.forEach(s => { orig.push(s); hs.push(h); });
    const toks = squeeze(l).split(/\s+/);
    // 「営業部 部長」のように部署と役職が同じ行にある場合は分ける
    if (toks.length > 1 && !/[\d@]/.test(l) && toks.every(t => t.length > 1 && (TITLE_RE.test(t) || DEPT_RE.test(t)))) push(...toks);
    else {
      const sq = squeeze(l), m = !/[\d@]/.test(sq) && sq.match(/^(.{1,12}?(?:本部|事業部|部|課|室))(.{2,})$/);
      if (m && TITLE_RE.test(m[2]) && !TITLE_RE.test(m[1])) push(m[1], m[2]); else push(l);
    }
  });
  const lines = orig.map(squeeze);
  const r = { last: '', first: '', yomi: '', company: '', dept: '', title: '', country: '', email: '', tel: '', mobile: '', fax: '', address: '', memo: '' };
  const used = new Set();
  const take = (i) => used.add(i);

  lines.forEach((l, i) => {
    const m = l.match(/[\w.+\-]+\s?@\s?[\w\-]+(\.[\w\-]+)+/);
    if (m && !r.email) { r.email = m[0].replace(/\s/g, ''); take(i); }
    else if (/^(https?:|www\.)/i.test(l) || /^[\w\-]+(\.[\w\-]+)+\/?$/.test(l)) take(i);
  });
  lines.forEach((l, i) => {
    if (used.has(i)) return;
    const re = /(\+?\d[\d\-\s().]{7,}\d)/g; let m, last = 0;
    while ((m = re.exec(l))) {
      const num = m[1].trim(), digits = num.replace(/\D/g, ''), label = l.slice(last, m.index);
      last = m.index + m[0].length;
      if (digits.length < 9 || digits.length > 13) continue;
      let key = 'tel';
      if (/fax|ファックス|ファクス/i.test(label)) key = 'fax';
      else if (/mobile|cell|携帯|mob\b|\bM\s*[.:：]/i.test(label) || /^0[789]0/.test(digits) || /^81[789]0/.test(digits)) key = 'mobile';
      if (!r[key]) { r[key] = num; take(i); }
    }
  });
  const addr = [];
  lines.forEach((l, i) => {
    if (used.has(i)) return;
    if (/〒|\b\d{3}-\d{4}\b|(都|道|府|県).{1,10}(市|区|町|村|郡)|\d.*(Street|St\.|Ave|Road|Rd\.|Suite|Floor|Blvd)/i.test(l)) { addr.push(l); take(i); }
  });
  r.address = addr.join(' ');
  lines.forEach((l, i) => { if (!used.has(i) && /株式会社|有限会社|合同会社|一般社団|\b(Inc|Corp|Co|Ltd|LLC|GmbH|Company|Corporation)\b\.?|大学|Group$|グループ$/i.test(l)) { if (!r.company) r.company = l; take(i); } });
  lines.forEach((l, i) => { if (!used.has(i) && /(部長|課長|取締役|社長|代表|主任|マネージャ|リーダー|室長|係長|所長|店長|教授|CEO|CTO|COO|CFO|President|Director|Manager|Engineer|Officer|Head|Lead|Chief|Representative|Professor)/i.test(l)) { if (!r.title) r.title = l; take(i); } });
  lines.forEach((l, i) => { if (!used.has(i) && /(部|課|室|本部|センター|事業所|営業所|支店|支社|本社|工場|研究所|事務所|Department|Dept|Division|Branch|Office|Team|チーム)$/i.test(l)) { if (!r.dept) r.dept = l; take(i); } });
  lines.forEach((l, i) => { if (!used.has(i) && /^[぀-ゟ゠-ヿー\s]{3,24}$/.test(l)) { if (!r.yomi) r.yomi = kata2hira(l.replace(/\s/g, '')); take(i); } });
  // 名前候補: 組織名らしい行を除き、最も大きい文字(名刺では名前が最大のことが多い)を選ぶ
  const ORG = /事業所|営業所|支店|支社|本社|工場|研究所|事務所|センター|病院|学校|大学|協会|組合|銀行|法人|株式|会社|店$|部$|課$|室$|Inc|Corp|Ltd|LLC|Co\.|Office|Branch|Dept|Division|Group/i;
  const cands = [];
  lines.forEach((l, i) => {
    if (used.has(i) || /\d|@/.test(l) || l.length > 12 || ORG.test(l)) return;
    if (new RegExp(CJK).test(l) && l.length >= 2) cands.push({ i, jp: true });
    else if (/^[A-Za-z][A-Za-z.'\- ]+$/.test(l) && l.split(/\s+/).length <= 4) cands.push({ i, jp: false });
  });
  const pool = cands.some(c => c.jp) ? cands.filter(c => c.jp) : cands;
  pool.sort((a, b) => (hs[b.i] - hs[a.i]) || (a.i - b.i));
  const best = pool[0];
  if (best) {
    const l = lines[best.i], o = orig[best.i];
    if (best.jp) { const toks = o.split(/[ 　]+/); if (toks.length === 2) { r.last = toks[0]; r.first = toks[1]; } else r.last = l; }
    else { const p = l.split(/\s+/); r.last = p.length > 1 ? p[p.length - 1] : l; r.first = p.length > 1 ? p.slice(0, -1).join(' ') : ''; }
    take(best.i);
  }
  if (new RegExp('[\\u3040-\\u30ff\\u4e00-\\u9fff]').test(raw) && /〒|都|道|府|県|\+81|^0/.test(r.address + r.tel)) r.country = '日本';
  const rest = lines.filter((_, i) => !used.has(i));
  if (rest.length) r.memo = rest.join('\n');
  return r;
}

/* ========== 画面管理 ========== */
const app = $('#app'), titleEl = $('#title'), backBtn = $('#back'), hright = $('#hright');
const stack = [];
let urls = [];
function revokeUrls() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }
function go(view, ...args) { stack.push([view, args]); show(); }
function back() { stack.pop(); show(); }
function show() {
  revokeUrls();
  const [view, args] = stack[stack.length - 1] || ['list', []];
  backBtn.hidden = stack.length <= 1; hright.innerHTML = '';
  window.scrollTo(0, 0);
  ({ list: viewList, scan: viewScan, form: viewForm, detail: viewDetail })[view](...args);
}
backBtn.onclick = back;

/* ----- 一覧 ----- */
const ui = { sort: 'name', mode: 'image', q: '' };
async function viewList() {
  titleEl.textContent = '名刺管理';
  ui.mode = await DB.setting('listMode', 'image');
  app.innerHTML = `
    <input class="search" id="q" type="search" placeholder="検索(名前・会社・国・メモ)" value="${esc(ui.q)}">
    <div class="seg" id="sortSeg">
      <button data-v="name">名前順</button><button data-v="company">会社名順</button><button data-v="met">最終面談日順</button></div>
    <div class="seg" id="modeSeg"><button data-v="image">画像付き</button><button data-v="text">文字だけ</button></div>
    <div class="count" id="cnt"></div><div id="listBox"></div>
    <button class="fab" id="add">＋ 撮影</button>`;
  const cards = await DB.all('cards');
  const thumbs = new Map((await DB.all('thumbs')).map(t => { let u = t.url; if (!u && (t.blob || t.buf)) { u = URL.createObjectURL(blobOf(t)); } return [t.id, u]; }));
  const draw = () => {
    revokeUrls();
    document.querySelectorAll('#sortSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.sort));
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === ui.mode));
    const q = ui.q.trim().toLowerCase();
    let L = cards.filter(c => !q || [c.last, c.first, c.yomi, c.company, c.dept, c.title, c.country, c.email, c.memo, ...(c.meetings || []).map(m => `${m.place} ${m.note}`)].join('\n').toLowerCase().includes(q));
    const by = { name: c => sortKey(c), company: c => kata2hira((c.company || '').toLowerCase()), met: c => lastMet(c) };
    L.sort(ui.sort === 'met'
      ? (a, b) => (lastMet(b) ? 1 : 0) - (lastMet(a) ? 1 : 0) || cmp(lastMet(b), lastMet(a)) || cmp(sortKey(a), sortKey(b))
      : (a, b) => cmp(by[ui.sort](a), by[ui.sort](b)) || cmp(sortKey(a), sortKey(b)));
    $('#cnt').textContent = `${L.length}件  (版 ${APP_VERSION})`;
    $('#listBox').innerHTML = L.length ? `<div class="list">${L.map(c => {
      let img = '';
      if (ui.mode === 'image') {
        const b = thumbs.get(c.id);
        if (b) img = `<img src="${b}" alt="">`; else img = '<div class="noimg">画像なし</div>';
      }
      return `<div class="row" data-id="${c.id}">${img}<div class="t"><div class="n">${esc(displayName(c))}</div><div class="s">${esc([c.company, c.title].filter(Boolean).join(' / '))}</div></div></div>`;
    }).join('')}</div>` : `<div class="empty">${cards.length ? '該当する名刺がありません' : '名刺がまだありません<br>右下の「＋ 撮影」から追加しましょう'}</div>`;
  };
  draw();
  $('#q').oninput = e => { ui.q = e.target.value; draw(); };
  $('#sortSeg').onclick = e => { if (e.target.dataset.v) { ui.sort = e.target.dataset.v; draw(); } };
  $('#modeSeg').onclick = async e => { if (e.target.dataset.v) { ui.mode = e.target.dataset.v; await DB.setSetting('listMode', ui.mode); draw(); } };
  $('#listBox').onclick = e => { const r = e.target.closest('.row'); if (r) go('detail', r.dataset.id); };
  $('#add').onclick = () => go('scan');
}

/* ----- 撮影・読み取り ----- */
async function viewScan() {
  titleEl.textContent = '名刺を読み取る';
  const saveImg = await DB.setting('saveImage', true);
  app.innerHTML = `
    <div class="panel">
      <button class="big" id="cam">📷 カメラで撮影</button>
      <button class="big alt" id="alb">🖼 アルバムから選ぶ</button>
      <button class="big alt" id="manual">✍️ 手入力で登録</button>
      <input type="file" id="fCam" accept="image/*" capture="environment" hidden>
      <input type="file" id="fAlb" accept="image/*" hidden>
      <label class="sw"><span>名刺の画像を保存する</span><input type="checkbox" id="saveImg" ${saveImg ? 'checked' : ''}></label>
      <p class="sub">名刺を平らな場所に置き、明るい場所でまっすぐ撮影すると精度が上がります。読み取りはすべて端末内で行われ、外部には送信されません。</p>
    </div>
    <div id="prog" class="panel" hidden><img class="preview" id="pv" alt=""><div class="bar"><i id="pb"></i></div><div class="sub" id="pt">準備中…</div></div>`;
  $('#cam').onclick = () => $('#fCam').click();
  $('#alb').onclick = () => $('#fAlb').click();
  $('#manual').onclick = () => { stack.pop(); go('form', null, { prefill: {}, img: null, thumb: null, raw: '' }); };
  $('#saveImg').onchange = e => DB.setSetting('saveImage', e.target.checked);
  const handle = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#prog').hidden = false; ['cam', 'alb', 'manual'].forEach(i => $('#' + i).disabled = true);
    const pt = $('#pt'), pb = $('#pb');
    try {
      pt.textContent = '画像を処理中…';
      const bmp = await loadImage(f);
      const full = toCanvas(bmp, 1600), ocrC = toCanvas(bmp, 2000), th = toCanvas(bmp, 320);
      const imgBlob = full.toDataURL('image/jpeg', .8), thBlob = th.toDataURL('image/jpeg', .7);
      $('#pv').src = imgBlob;
      pt.textContent = '読み取りエンジンを準備中…(初回は少し時間がかかります)';
      const ocr = await runOCR(ocrC, m => {
        if (m.status === 'recognizing text') { pb.style.width = Math.round(m.progress * 100) + '%'; pt.textContent = `文字を読み取り中… ${Math.round(m.progress * 100)}%`; }
        else pt.textContent = '準備中…';
      });
      const keep = $('#saveImg').checked;
      stack.pop(); go('form', null, { prefill: parseCard(ocr.text, ocr.lines), img: keep ? imgBlob : null, thumb: keep ? thBlob : null, raw: ocr.text });
    } catch (err) {
      console.error(err);
      pt.textContent = '読み取りに失敗しました: ' + (err && err.message || err) + '(手入力でも登録できます)';
      ['cam', 'alb', 'manual'].forEach(i => $('#' + i).disabled = false);
    }
  };
  $('#fCam').onchange = handle; $('#fAlb').onchange = handle;
}

/* ----- 確認・修正・保存 ----- */
async function viewForm(id, opt = {}) {
  let card = id ? await DB.get('cards', id) : null;
  titleEl.textContent = card ? '名刺を編集' : '内容を確認';
  const v = card || opt.prefill || {};
  app.innerHTML = `
    <form id="frm">
      ${opt.img ? `<div class="panel"><img class="preview" id="pv" alt=""></div>` : ''}
      ${card ? '' : `<details class="panel" ${opt.raw ? '' : 'open'}><summary class="sub">読み取った文字(直して再解析できます)</summary>
        <p class="sub">iPhoneの文字認識が使えます。下の欄をタップ → 「テキストをスキャン」で名刺を写して「挿入」。または上の画像を長押しして文字をコピーし、貼り付けます。</p>
        <textarea id="rawTxt" placeholder="ここに名刺の文字が入ります">${esc(opt.raw)}</textarea>
        <button class="big alt" type="button" id="reparse" style="margin:8px 0 0">この文字で項目に振り分け直す</button></details>`}
      <p class="sub">読み取り結果です。間違いがあれば直してから保存してください。</p>
      <div class="two">${['last', 'first'].map(k => fld(k, v)).join('')}</div>
      ${FIELDS.slice(2).map(f => fld(f[0], v)).join('')}
      <button class="big" type="submit">保存</button>
    </form>
    <datalist id="countries">${['日本', 'アメリカ', 'イギリス', '中国', '韓国', '台湾', 'シンガポール', 'インド', 'ドイツ', 'フランス', 'オーストラリア', 'カナダ'].map(c => `<option value="${c}">`).join('')}</datalist>`;
  function fld(k, val) {
    const [, label, type] = FIELDS.find(f => f[0] === k);
    const a = `name="${k}" id="f_${k}"${k === 'country' ? ' list="countries"' : ''}`;
    const input = type === 'textarea' ? `<textarea ${a}>${esc(val[k])}</textarea>` : `<input ${a} type="${type || 'text'}" value="${esc(val[k])}" ${type === 'email' ? 'inputmode="email" autocapitalize="off"' : ''} ${type === 'tel' ? 'inputmode="tel"' : ''}>`;
    return `<div class="f"><label for="f_${k}">${label}</label>${input}</div>`;
  }
  if (opt.img) $('#pv').src = opt.img;
  if ($('#reparse')) $('#reparse').onclick = () => {
    const p = parseCard($('#rawTxt').value);
    for (const k in p) { const el = $('#f_' + k); if (el) el.value = p[k]; }
    toast('振り分け直しました');
  };
  $('#frm').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    for (const k in d) d[k] = d[k].trim();
    d.yomi = kata2hira(d.yomi);
    if (!d.last && !d.first && !d.company) { toast('名前か会社名を入力してください'); return; }
    const now = Date.now();
    const saved = { ...(card || { id: uid(), meetings: [], createdAt: now }), ...d, updatedAt: now };
    try {
      await DB.saveCard(saved, opt.img, opt.thumb);
    } catch (err) { console.error(err); alert('保存に失敗しました: ' + (err && err.message || err)); return; }
    toast('保存しました');
    stack.length = 0; stack.push(['list', []]); show();
  };
}

/* ----- 詳細 ----- */
async function viewDetail(id) {
  const c = await DB.get('cards', id);
  if (!c) { back(); return; }
  titleEl.textContent = displayName(c);
  hright.innerHTML = '<button class="hbtn" id="edit">編集</button>';
  const img = await DB.get('images', id);
  const dig = s => s.replace(/[^\d+]/g, '');
  const show1 = (label, html) => html ? `<dt>${label}</dt><dd>${html}</dd>` : '';
  const tel = s => s ? `<a href="tel:${esc(dig(s))}">${esc(s)}</a>` : '';
  app.innerHTML = `<div class="panel d"><dl style="margin:0">
    ${show1('名前', esc(displayName(c)))}${show1('読み', esc(c.yomi))}${show1('会社名', esc(c.company))}${show1('部署', esc(c.dept))}${show1('役職', esc(c.title))}${show1('国', esc(c.country))}
    ${show1('メール', c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '')}
    ${show1('会社電話', tel(c.tel))}${show1('携帯電話', tel(c.mobile))}${show1('FAX', esc(c.fax))}
    ${show1('住所', esc(c.address))}${show1('メモ', esc(c.memo))}
    ${img ? `<dt>名刺画像</dt><dd><img id="im" alt=""></dd>` : ''}</dl></div>
    <button class="big danger" id="del">この名刺を削除</button>`;
  if (img) { let u = img.url; if (!u) { u = URL.createObjectURL(blobOf(img)); urls.push(u); } $('#im').src = u; }
  $('#edit').onclick = () => go('form', id, {});
  $('#del').onclick = async () => {
    if (!confirm(`「${displayName(c)}」を削除します。元に戻せません。よろしいですか?`)) return;
    await DB.delCard(id); toast('削除しました'); back();
  };
}

/* ========== 起動 ========== */
stack.push(['list', []]); show();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
