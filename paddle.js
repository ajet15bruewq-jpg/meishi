'use strict';
/* 高精度OCR(試験版): PaddleOCR PP-OCRv5 mobile を onnxruntime-web で端末内実行。外部送信なし。
   文字の位置を探す(det)→各行を読む(rec) の2段階。 */
const Paddle = (() => {
  const base = new URL('./', location.href).href;
  const FILES = ['lib/ort/ort.wasm.min.js', 'lib/ort/ort-wasm-simd.wasm', 'models/det.onnx', 'models/rec.onnx', 'models/dict.txt'];
  let det, rec, dict;

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('読み込みに失敗: ' + src)); document.head.append(s);
  });

  async function init(onStatus = () => { }) {
    if (rec) return;
    onStatus('高精度エンジンを準備中…');
    if (!window.ort) await loadScript(base + 'lib/ort/ort.wasm.min.js');
    const ort = window.ort;
    ort.env.wasm.numThreads = 1;               // GitHub Pagesでは複数スレッドが使えない
    ort.env.wasm.wasmPaths = base + 'lib/ort/';
    const get = async f => { const r = await fetch(base + f); if (!r.ok) throw new Error(f + ' が取得できません'); return r; };
    const [d, r, t] = await Promise.all([get('models/det.onnx').then(x => x.arrayBuffer()), get('models/rec.onnx').then(x => x.arrayBuffer()), get('models/dict.txt').then(x => x.text())]);
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    det = await ort.InferenceSession.create(new Uint8Array(d), opt);
    rec = await ort.InferenceSession.create(new Uint8Array(r), opt);
    dict = ['', ...t.split('\n'), ' ']; // CTC: 先頭は空白(blank)、末尾は半角スペース
  }

  // ---- 文字領域の検出 ----
  async function detect(canvas) {
    const W = canvas.width, H = canvas.height, s = 960 / Math.max(W, H);
    const w = Math.max(32, Math.round(W * s / 32) * 32), h = Math.max(32, Math.round(H * s / 32) * 32);
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, n = w * h, f = new Float32Array(3 * n);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];   // BGR順(PaddleOCRの学習時と同じ)
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[k * n + i] = (px[i * 4 + (2 - k)] / 255 - mean[k]) / std[k];
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, h, w]) });
    const prob = out[det.outputNames[0]].data;
    // しきい値以上の画素をつなげて「文字の塊」にする
    const lab = new Int32Array(n), stack = new Int32Array(n), boxes = [];
    for (let i = 0; i < n; i++) {
      if (prob[i] <= 0.3 || lab[i]) continue;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, sum = 0, cnt = 0; stack[sp++] = i; lab[i] = 1;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; cnt++; sum += prob[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && prob[p - 1] > 0.3 && !lab[p - 1]) { lab[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && prob[p + 1] > 0.3 && !lab[p + 1]) { lab[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && prob[p - w] > 0.3 && !lab[p - w]) { lab[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && prob[p + w] > 0.3 && !lab[p + w]) { lab[p + w] = 1; stack[sp++] = p + w; }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.min(bw, bh) < 3 || sum / cnt < 0.5) continue;
      const dd = bw * bh * 1.5 / (2 * (bw + bh));          // 縮められた領域を元の大きさに広げる
      boxes.push({ x0: Math.max(0, (x0 - dd) / w * W), y0: Math.max(0, (y0 - dd) / h * H), x1: Math.min(W, (x1 + 1 + dd) / w * W), y1: Math.min(H, (y1 + 1 + dd) / h * H) });
    }
    return boxes;
  }

  // ---- 1行ぶんを読む ----
  async function recognize(canvas, b) {
    const cw = Math.max(1, Math.round(b.x1 - b.x0)), ch = Math.max(1, Math.round(b.y1 - b.y0));
    const tall = ch / cw >= 1.5;                           // 縦書きは90度回してから読む
    let c = document.createElement('canvas');
    if (tall) { c.width = ch; c.height = cw; const g = c.getContext('2d'); g.translate(0, cw); g.rotate(-Math.PI / 2); g.drawImage(canvas, b.x0, b.y0, cw, ch, 0, 0, cw, ch); }
    else { c.width = cw; c.height = ch; c.getContext('2d').drawImage(canvas, b.x0, b.y0, cw, ch, 0, 0, cw, ch); }
    const w = Math.min(3200, Math.max(16, Math.ceil(48 * c.width / c.height))), r = document.createElement('canvas'); r.width = w; r.height = 48;
    r.getContext('2d').drawImage(c, 0, 0, w, 48);
    const px = r.getContext('2d').getImageData(0, 0, w, 48).data, n = w * 48, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[k * n + i] = (px[i * 4 + (2 - k)] / 255 - 0.5) / 0.5;
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 48, w]) });
    const o = out[rec.outputNames[0]], [, T, C] = o.dims, d = o.data;
    let text = '', last = 0, conf = 0, k = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -1; for (let j = 0; j < C; j++) { const v = d[t * C + j]; if (v > bv) { bv = v; best = j; } }
      if (best !== 0 && best !== last) { text += dict[best] ?? ''; conf += bv; k++; }
      last = best;
    }
    return { text: text.trim(), conf: k ? conf / k : 0, tall };
  }

  // 同じ行にある文字の塊をつなげて1行にする(「TEL …  FAX …」などを1行で扱うため)
  function toLines(items) {
    const rows = [];
    items.filter(i => !i.tall).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)).forEach(i => {
      const row = rows.find(r => Math.min(r.y1, i.y1) - Math.max(r.y0, i.y0) > 0.5 * Math.min(r.y1 - r.y0, i.y1 - i.y0));
      if (row) { row.items.push(i); row.y0 = Math.min(row.y0, i.y0); row.y1 = Math.max(row.y1, i.y1); } else rows.push({ y0: i.y0, y1: i.y1, items: [i] });
    });
    const lines = rows.sort((a, b) => a.y0 - b.y0).map(r => ({ text: r.items.sort((a, b) => a.x0 - b.x0).map(i => i.text).join(' '), bbox: { y0: r.y0, y1: Math.max(...r.items.map(i => i.y1)) } , h: Math.max(...r.items.map(i => i.y1 - i.y0)) }));
    items.filter(i => i.tall).sort((a, b) => b.x0 - a.x0).forEach(i => lines.push({ text: i.text, bbox: { y0: i.y0, y1: i.y1 }, h: i.x1 - i.x0 }));
    // 行の高さ = 最も大きい文字の高さ(名前判定に使う)
    return lines.map(l => ({ text: l.text, bbox: { y0: 0, y1: l.h } }));
  }

  async function run(canvas, cb = () => { }) {
    await init(label => cb({ status: 'init', label }));
    cb({ status: 'init', label: '文字の位置を探しています…' });
    const boxes = await detect(canvas);
    if (!boxes.length) return { text: '', lines: [] };
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      cb({ status: 'recognizing text', progress: i / boxes.length, label: `文字を読み取り中… ${Math.round(i / boxes.length * 100)}%` });
      const b = boxes[i], r = await recognize(canvas, b);
      if (r.text && r.conf > 0.3) items.push({ ...b, text: r.text, tall: r.tall });
    }
    const lines = toLines(items);
    return { text: lines.map(l => l.text).join('\n'), lines };
  }

  const isReady = async () => { try { const c = await caches.keys(); for (const k of c) { const ca = await caches.open(k); if (await ca.match('models/rec.onnx') && await ca.match('lib/ort/ort-wasm-simd.wasm')) return true; } } catch (e) { } return false; };
  async function download(onProgress = () => { }) {
    let i = 0;
    for (const f of FILES) { const r = await fetch(base + f); if (!r.ok) throw new Error(f + ' を取得できません'); await r.arrayBuffer(); onProgress(++i / FILES.length); }
  }
  return { run, init, isReady, download, FILES };
})();
