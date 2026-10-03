import { paper, TILE } from './paper.js?v=8';
import { Painter, BRUSHES, diameter } from './engine.js?v=8';
import { sceneDesign, imageToDesign, hexLum } from './design.js?v=8';
import * as store from './storage.js?v=8';
import { generateImage, DEFAULT_MODEL } from './ai.js?v=8';

const $ = id => document.getElementById(id);
const sheet = $('sheet'), world = $('world'), paintCv = $('paint'), liveCv = $('live'), svg = $('lineart');
const painter = new Painter(paintCv, liveCv);
const NS = 'http://www.w3.org/2000/svg';

const P = store.prefs;
const st = {
  design: null,
  brush: P.get('brush', 'pencil'),
  lastBrush: P.get('lastBrush', 'pencil'),
  size: P.get('size', 14),
  opacity: P.get('opacity', 85),
  num: 1,
  detail: P.get('detail', 1),
  view: { s: 1, x: 0, y: 0, fit: 1 },
  prevView: null,
};

/* ================= 도안 적용 ================= */
let texts = [], samples = [], done = null, numRegions = [];
async function applyDesign(d, paintBlob, { fresh = false } = {}) {
  st.design = d;
  world.style.width = d.w + 'px'; world.style.height = d.h + 'px';
  const pp = $('paper');
  pp.style.width = d.w + 'px'; pp.style.height = d.h + 'px';
  painter.setup(d.w, d.h);
  await painter.load(paintBlob);

  // 선화 + 번호
  svg.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
  svg.setAttribute('width', d.w); svg.setAttribute('height', d.h);
  svg.innerHTML = '';
  const lines = document.createElementNS(NS, 'path');
  lines.setAttribute('class', 'lines'); lines.setAttribute('d', d.path); lines.setAttribute('stroke-width', d.lineWidth);
  const nums = document.createElementNS(NS, 'g'); nums.setAttribute('class', 'nums');
  texts = d.labels.map((l, r) => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', l.x); t.setAttribute('y', l.y); t.setAttribute('font-size', l.fs);
    t.textContent = d.regionNum[r] + 1;
    nums.appendChild(t);
    return t;
  });
  svg.append(nums, lines);
  if (d.extra) {
    const ex = document.createElementNS(NS, 'path');
    ex.setAttribute('class', 'lines'); ex.setAttribute('d', d.extra); ex.setAttribute('stroke-width', d.lineWidth * .85);
    svg.appendChild(ex);
  }

  // 칠한 정도 판정용 표본
  const n = d.labels.length, N = d.gw * d.gh;
  const lists = Array.from({ length: n }, () => []);
  for (let i = 0; i < N; i++) lists[d.reg[i]].push(i);
  samples = lists.map(a => { if (a.length <= 300) return Int32Array.from(a); const o = new Int32Array(300), stp = a.length / 300; for (let k = 0; k < 300; k++) o[k] = a[Math.floor(k * stp)]; return o; });
  done = new Uint8Array(n);
  numRegions = d.palette.map(() => []);
  d.regionNum.forEach((k, r) => numRegions[k].push(r));

  buildPreview(d);
  st.num = Math.min(Math.max(1, P.get('num', 1)), d.palette.length);
  buildPalette();
  { const W = sheet.clientWidth, H = sheet.clientHeight, r = Math.max(W / d.w, H / d.h) / Math.min(W / d.w, H / d.h); fitView(r < 1.25); }
  coverage(null);
  setNum(st.num);
  drawMini();
  if (fresh) { await store.set('design', d); await saveNow(); }
}

/* ================= 완성 미리보기 ================= */
const prevCv = document.createElement('canvas');
function buildPreview(d) {
  prevCv.width = d.gw; prevCv.height = d.gh;
  const c = prevCv.getContext('2d'), im = c.createImageData(d.gw, d.gh), px = im.data;
  const rgb = d.palette.map(h => { const v = parseInt(h.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; });
  for (let i = 0; i < d.reg.length; i++) { const k = rgb[d.regionNum[d.reg[i]]]; px[i * 4] = k[0]; px[i * 4 + 1] = k[1]; px[i * 4 + 2] = k[2]; px[i * 4 + 3] = 255; }
  c.putImageData(im, 0, 0);
  const ref = $('ref'), sc = Math.min(1, 1600 / d.w);
  ref.width = Math.round(d.w * sc); ref.height = Math.round(d.h * sc);
  ref.style.width = d.w + 'px'; ref.style.height = d.h + 'px';
  const rc = ref.getContext('2d'); rc.imageSmoothingQuality = 'high'; rc.drawImage(prevCv, 0, 0, ref.width, ref.height);
}

/* ================= 칠함 판정 (번호 숨김) ================= */
const covCv = document.createElement('canvas');
const covCtx = covCv.getContext('2d', { willReadFrequently: true });
function coverage(box) {
  const d = st.design; if (!d) return;
  if (covCv.width !== d.gw || covCv.height !== d.gh) { covCv.width = d.gw; covCv.height = d.gh; }
  covCtx.clearRect(0, 0, d.gw, d.gh);
  covCtx.drawImage(paintCv, 0, 0, d.gw, d.gh);
  const a = covCtx.getImageData(0, 0, d.gw, d.gh).data;
  let regs;
  if (box) {
    const g = d.gw / d.w, set = new Set();
    const x0 = Math.max(0, Math.floor(box.x * g)), y0 = Math.max(0, Math.floor(box.y * g));
    const x1 = Math.min(d.gw, Math.ceil((box.x + box.w) * g)), y1 = Math.min(d.gh, Math.ceil((box.y + box.h) * g));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set.add(d.reg[y * d.gw + x]);
    regs = [...set];
  } else regs = samples.map((_, r) => r);
  const touchedNums = new Set();
  for (const r of regs) {
    const sm = samples[r]; let c = 0;
    for (let k = 0; k < sm.length; k++) if (a[sm[k] * 4 + 3] > 70) c++;
    const isDone = c / sm.length > .6 ? 1 : 0;
    if (isDone !== done[r]) { done[r] = isDone; texts[r].classList.toggle('done', !!isDone); }
    touchedNums.add(d.regionNum[r]);
  }
  for (const k of (box ? touchedNums : d.palette.keys())) {
    const chip = palEl.children[k]; if (!chip) continue;
    chip.classList.toggle('done', numRegions[k].length > 0 && numRegions[k].every(r => done[r]));
  }
}

/* ================= 팔레트 ================= */
const palEl = $('palette');
function buildPalette() {
  const d = st.design;
  palEl.innerHTML = '';
  d.palette.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.setAttribute('aria-label', `${i + 1}번 색`);
    const dark = hexLum(c) > .62;
    b.style.setProperty('--ck', dark ? '#232428' : '#fff');
    b.innerHTML = `<i style="background:${c}"></i><b style="color:${dark ? '#232428' : '#fff'}">${i + 1}</b>`;
    b.onclick = () => { setNum(i + 1); if (st.brush === 'eraser') setBrush(st.lastBrush); };
    palEl.appendChild(b);
  });
}
function setNum(n) {
  st.num = n; P.set('num', n);
  [...palEl.children].forEach((c, i) => c.classList.toggle('on', i === n - 1));
  const d = st.design;
  texts.forEach((t, r) => t.classList.toggle('hl', d.regionNum[r] === n - 1));
  document.documentElement.style.setProperty('--oc', color());
  renderBrushUI();
}
const color = () => st.design.palette[st.num - 1];

/* ================= 펜 ================= */
const SW = {
  pencil: c => `<path d="M6 18 C14 6 22 22 30 12 S40 8 44 10" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-dasharray="1.2 1.6" opacity=".9"/><path d="M6 18 C14 6 22 22 30 12 S40 8 44 10" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity=".7"/>`,
  oil: c => `<path d="M6 15 C16 9 28 19 44 12" fill="none" stroke="${c}" stroke-width="11" stroke-linecap="round"/><path d="M8 12.5 C17 7.5 28 16 42 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".5"/><path d="M8 17.5 C18 12 28 21 42 14.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" opacity=".18"/>`,
  fine: c => `<path d="M6 17 C14 8 22 20 30 11 S40 9 44 10" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/><path d="M10 19 C18 12 26 22 40 15" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`,
  marker: c => `<path d="M6 16 L44 12" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" opacity=".6"/><path d="M14 17 L36 13" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" opacity=".45"/>`,
  wc: c => `<path d="M7 13 C14 5 24 9 31 7 S45 10 43 16 S30 21 22 19 S5 20 7 13Z" fill="${c}" opacity=".35" stroke="${c}" stroke-width="1.6" stroke-opacity=".9"/><circle cx="19" cy="12" r="3.5" fill="${c}" opacity=".3"/>`,
  eraser: () => `<g transform="translate(13 1)" fill="none" stroke="#5C5F66" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3 21 8 10 19H5v-5z"/><path d="m11 8 5 5"/><path d="M14 21h7"/></g>`,
};
const bcur = $('bcur'), menu = $('brushMenu');
function renderBrushUI() {
  if (!st.design) return;
  const c = color(), label = BRUSHES.find(b => b[0] === st.brush)[1];
  bcur.innerHTML = `<svg class="chev" viewBox="0 0 14 14"><path d="M9 3 5 7l4 4"/></svg><svg class="sw" viewBox="0 0 50 26">${SW[st.brush](c)}</svg><span>${label}</span>`;
  menu.innerHTML = BRUSHES.map(([k, l]) => `<button class="brush${k === st.brush ? ' on' : ''}" data-k="${k}" role="menuitem"><svg viewBox="0 0 50 26">${SW[k](c)}</svg>${l}</button>`).join('');
}
function setBrush(b) {
  if (b !== 'eraser') { st.lastBrush = b; P.set('lastBrush', b); }
  st.brush = b; P.set('brush', b);
  renderBrushUI();
}
function toggleEraser() { setBrush(st.brush === 'eraser' ? st.lastBrush : 'eraser'); toast(st.brush === 'eraser' ? '지우개' : BRUSHES.find(x => x[0] === st.brush)[1]); }
bcur.onclick = e => {
  e.stopPropagation();
  const open = !menu.classList.contains('open');
  if (open) {
    const r = bcur.getBoundingClientRect();
    menu.style.right = (innerWidth - r.left + 16) + 'px';
    menu.style.bottom = (innerHeight - r.bottom) + 'px';
  }
  menu.classList.toggle('open', open); bcur.setAttribute('aria-expanded', open);
};
menu.onclick = e => { const b = e.target.closest('.brush'); if (!b) return; setBrush(b.dataset.k); menu.classList.remove('open'); bcur.setAttribute('aria-expanded', false); };
document.addEventListener('pointerdown', e => { if (menu.classList.contains('open') && !menu.contains(e.target) && !bcur.contains(e.target)) { menu.classList.remove('open'); bcur.setAttribute('aria-expanded', false); } });

/* ================= 슬라이더 ================= */
function slider(track, valEl, min, max, init, fmt, dia, on) {
  const th = track.querySelector('.thumb');
  const set = x => {
    const v = Math.round(Math.max(min, Math.min(max, x))), t = (v - min) / (max - min), h = track.clientHeight, d = dia(t);
    Object.assign(th.style, { top: (1 - t) * (h - 12) + 6 + 'px', width: d + 'px', height: d + 'px', margin: `${-d / 2}px 0 0 ${-d / 2}px` });
    valEl.textContent = fmt(v); track.setAttribute('aria-valuenow', v); on(v);
  };
  const from = e => { const r = track.getBoundingClientRect(); set(min + (1 - (e.clientY - r.top) / r.height) * (max - min)); };
  track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); from(e); });
  track.addEventListener('pointermove', e => { if (track.hasPointerCapture(e.pointerId)) from(e); });
  new ResizeObserver(() => set(on.cur ?? init)).observe(track);
  set(init);
  return set;
}
const onSize = v => { st.size = v; onSize.cur = v; P.set('size', v); };
const onOp = v => { st.opacity = v; onOp.cur = v; P.set('opacity', v); };
slider($('sizeTrack'), $('sizeVal'), 1, 40, st.size, v => v, t => 8 + t * 20, onSize);
slider($('opTrack'), $('opVal'), 10, 100, st.opacity, v => v + '%', () => 22, onOp);

/* ================= 되돌리기 ================= */
painter.onHistory = () => { $('undo').disabled = !painter.canUndo; $('redo').disabled = !painter.canRedo; };
function doUndo() { const b = painter.undo(); if (b) afterChange(b); }
function doRedo() { const b = painter.redo(); if (b) afterChange(b); }
$('undo').onclick = doUndo; $('redo').onclick = doRedo;

let miniT = 0;
function afterChange(box) {
  coverage(box);
  clearTimeout(miniT); miniT = setTimeout(drawMini, 250);
  scheduleSave();
}

/* ================= 화면 이동 / 확대 ================= */
function applyView() {
  const v = st.view;
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s})`;
  $('zoomVal').textContent = Math.round(v.s / v.fit * 100) + '%';
  drawVp();
}
function fitView(cover = false) {
  const d = st.design, W = sheet.clientWidth, H = sheet.clientHeight;
  const fit = Math.min(W / d.w, H / d.h), s = cover ? Math.max(W / d.w, H / d.h) : fit;
  st.view = { s, fit, x: (W - d.w * s) / 2, y: (H - d.h * s) / 2 };
  clampView(); applyView();
}
function clampView() {
  const v = st.view, d = st.design, W = sheet.clientWidth, H = sheet.clientHeight;
  v.s = Math.max(v.fit * .8, Math.min(v.fit * 10, v.s));
  const cw = d.w * v.s, ch = d.h * v.s, m = 80;
  v.x = cw < W ? (W - cw) / 2 : Math.min(m, Math.max(W - cw - m, v.x));
  v.y = ch < H ? (H - ch) / 2 : Math.min(m, Math.max(H - ch - m, v.y));
}
function zoomAt(px, py, ns) {
  const v = st.view, ws = Math.max(v.fit * .8, Math.min(v.fit * 10, ns));
  const wx = (px - v.x) / v.s, wy = (py - v.y) / v.s;
  v.s = ws; v.x = px - wx * ws; v.y = py - wy * ws;
  clampView(); applyView();
}
let lastSheet = '';
new ResizeObserver(() => {
  if (!st.design) return;
  const key = sheet.clientWidth + 'x' + sheet.clientHeight; if (key === lastSheet) return; lastSheet = key;
  const k = st.view.s / st.view.fit; fitView();
  zoomAt(sheet.clientWidth / 2, sheet.clientHeight / 2, st.view.fit * Math.max(1, k));
  drawMini();
}).observe(sheet);

let refT = 0, refShown = false;
const navBtn = $('navBtn');
navBtn.addEventListener('pointerdown', () => { refShown = false; clearTimeout(refT); refT = setTimeout(() => { refShown = true; $('ref').classList.add('show'); }, 280); });
const refEnd = () => { clearTimeout(refT); $('ref').classList.remove('show'); };
navBtn.addEventListener('pointerup', refEnd); navBtn.addEventListener('pointercancel', refEnd); navBtn.addEventListener('pointerleave', refEnd);
navBtn.addEventListener('contextmenu', e => e.preventDefault());
navBtn.onclick = () => {
  if (refShown) { refShown = false; return; }
  const v = st.view;
  if (Math.abs(v.s - v.fit) > .001) { st.prevView = { ...v }; fitView(); }
  else if (st.prevView) { st.view = { ...st.prevView, fit: v.fit }; clampView(); applyView(); }
};

/* ================= 미니맵 ================= */
const mini = $('mini'), mctx = mini.getContext('2d');
let mm = { s: 1, ox: 0, oy: 0 };
function drawMini() {
  const d = st.design; if (!d) return;
  const dpr = devicePixelRatio || 1, W = mini.clientWidth, H = mini.clientHeight;
  mini.width = W * dpr; mini.height = H * dpr;
  const s = Math.min(W / d.w, H / d.h); mm = { s, ox: (W - d.w * s) / 2, oy: (H - d.h * s) / 2 };
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.fillStyle = '#FCFCFC'; mctx.fillRect(0, 0, W, H);
  mctx.globalAlpha = .45; mctx.drawImage(prevCv, mm.ox, mm.oy, d.w * s, d.h * s); mctx.globalAlpha = 1;
  mctx.drawImage(paintCv, mm.ox, mm.oy, d.w * s, d.h * s);
  mctx.save(); mctx.translate(mm.ox, mm.oy); mctx.scale(s, s);
  mctx.strokeStyle = '#2A2A2D'; mctx.lineWidth = 1 / s * .6; mctx.stroke(new Path2D(d.path));
  mctx.restore();
  drawVp();
}
function drawVp() {
  const v = st.view, d = st.design; if (!d) return;
  const x0 = Math.max(0, -v.x / v.s), y0 = Math.max(0, -v.y / v.s);
  const x1 = Math.min(d.w, (sheet.clientWidth - v.x) / v.s), y1 = Math.min(d.h, (sheet.clientHeight - v.y) / v.s);
  Object.assign($('vp').style, { left: mm.ox + x0 * mm.s + 'px', top: mm.oy + y0 * mm.s + 'px', width: Math.max(4, (x1 - x0) * mm.s) + 'px', height: Math.max(4, (y1 - y0) * mm.s) + 'px' });
}

/* ================= 호버 커서 ================= */
const hover = $('hover');
let hoverT = 0;
function showHover(e) {
  const r = sheet.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const rad = Math.max(3, diameter(st.size, st.brush) * st.view.s / 2), S = Math.ceil(rad * 2 + 24), c = S / 2, col = st.brush === 'eraser' ? '#fff' : color();
  const key = st.brush + '|' + S + '|' + col;
  if (hover.dataset.key !== key) {
    hover.dataset.key = key;
    const halo = el => el.replace('/>', ' stroke="#fff" stroke-width="4" opacity=".9"/>') + el.replace('/>', ' stroke="#232428" stroke-width="1.5"/>');
    let g = '';
    if (st.brush === 'eraser') g = halo(`<rect x="${c - rad}" y="${c - rad * .7}" width="${rad * 2}" height="${rad * 1.4}" rx="${Math.min(8, rad * .3)}" fill="none" transform="rotate(-20 ${c} ${c})"/>`);
    else if (st.brush === 'pencil') g = halo(`<circle cx="${c}" cy="${c}" r="${rad}" fill="none"/>`) + `<circle cx="${c}" cy="${c}" r="2.5" fill="${col}" stroke="#232428" stroke-width="1"/>`;
    else if (st.brush === 'oil') {
      let t = ''; for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5; t += `<path d="M${c + Math.cos(a) * rad * .55} ${c + Math.sin(a) * rad * .55}L${c + Math.cos(a) * rad * .8} ${c + Math.sin(a) * rad * .8}" stroke="#232428" stroke-width="1.2" stroke-linecap="round" opacity=".5"/>`; }
      g = `<circle cx="${c}" cy="${c}" r="${rad}" fill="${col}" opacity=".18"/>` + halo(`<circle cx="${c}" cy="${c}" r="${rad}" fill="none"/>`) + (rad > 10 ? t : '');
    } else if (st.brush === 'fine') {
      g = halo(`<circle cx="${c}" cy="${c}" r="${Math.max(2, rad)}" fill="${col}"/>`) + `<circle cx="${c}" cy="${c}" r="${Math.max(6, rad + 5)}" fill="none" stroke="#232428" stroke-width="1" opacity=".35"/>`;
    } else if (st.brush === 'marker') {
      const rr = `x="${c - rad}" y="${c - rad * .36}" width="${rad * 2}" height="${rad * .72}" rx="${rad * .18}" transform="rotate(-36 ${c} ${c})"`;
      g = `<rect ${rr} fill="${col}" opacity=".25"/>` + halo(`<rect ${rr} fill="none"/>`);
    } else {
      g = `<circle cx="${c}" cy="${c}" r="${rad}" fill="${col}" opacity=".16"/><circle cx="${c}" cy="${c}" r="${rad}" fill="none" stroke="#fff" stroke-width="4" opacity=".9"/><circle cx="${c}" cy="${c}" r="${rad}" fill="none" stroke="#232428" stroke-width="1.5" stroke-dasharray="5 5"/>` +
        `<path d="M${c} ${c - 7}q5 6 5 9a5 5 0 0 1-10 0q0-3 5-9z" fill="${col}" stroke="#232428" stroke-width="1"/>`;
    }
    hover.innerHTML = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${g}</svg>`;
  }
  hover.style.transform = `translate(${px - c}px,${py - c}px)`;
  sheet.classList.add('hovering');
  clearTimeout(hoverT); hoverT = setTimeout(hideHover, e.pointerType === 'pen' ? 900 : 4000);
}
function hideHover() { sheet.classList.remove('hovering'); }

/* ================= 입력 (펜 · 손가락 제스처) ================= */
const toWorld = e => { const r = sheet.getBoundingClientRect(), v = st.view; return [(e.clientX - r.left - v.x) / v.s, (e.clientY - r.top - v.y) / v.s]; };
const touches = new Map();
let stroke = null;          // { id, finger }
let pendingFinger = null;   // { id, pts, timer }
let pinch = null;           // { d, mx, my, view }
let tap = null;             // { t, max, moved }
let lastPen = 0, panDrag = null;

function startStroke(e, brush, finger, pts) {
  const [x, y] = pts ? pts[0] : toWorld(e);
  painter.begin({ brush, color: color(), size: st.size, opacity: st.opacity / 100 }, x, y, e.pressure, !finger && e.pointerType === 'pen');
  if (pts) for (const p of pts.slice(1)) painter.move(p[0], p[1], 0);
  stroke = { id: e.pointerId, finger };
}
function endStroke() {
  if (!stroke) return;
  stroke = null;
  const box = painter.end();
  if (box) afterChange(box);
}
function pinchStart() {
  const [a, b] = [...touches.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...st.view } };
}

sheet.addEventListener('pointerdown', e => {
  if (menu.classList.contains('open')) return;
  const isTouch = e.pointerType === 'touch';
  sheet.setPointerCapture(e.pointerId);
  if (!isTouch) {
    if (e.pointerType === 'mouse' && e.button !== 0) { panDrag = { x: e.clientX, y: e.clientY, view: { ...st.view } }; return; }
    if (stroke && stroke.finger) { painter.cancel(); stroke = null; }
    if (pendingFinger) { clearTimeout(pendingFinger.timer); pendingFinger = null; }
    if (stroke) return;
    hideHover();
    lastPen = performance.now();
    startStroke(e, st.brush, false);
    return;
  }
  const r = sheet.getBoundingClientRect();
  touches.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top, sx: e.clientX, sy: e.clientY });
  if (!tap) tap = { t: performance.now(), max: 0, moved: false };
  tap.max = Math.max(tap.max, touches.size);
  if (stroke && !stroke.finger) return; // 펜 사용 중 손바닥 무시
  if (touches.size === 1) {
    if (performance.now() - lastPen < 700) return; // 펜이 가까이 있으면 손 닿음으로 간주
    const pts = [toWorld(e)];
    pendingFinger = { id: e.pointerId, pts, e, timer: setTimeout(() => { if (pendingFinger && touches.size === 1) { const p = pendingFinger; pendingFinger = null; startStroke(p.e, 'eraser', true, p.pts); } }, 90) };
  } else {
    if (pendingFinger) { clearTimeout(pendingFinger.timer); pendingFinger = null; }
    if (stroke && stroke.finger) { painter.cancel(); stroke = null; }
    if (touches.size >= 2) pinchStart();
  }
});

sheet.addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch') {
    if (panDrag) { st.view.x = panDrag.view.x + e.clientX - panDrag.x; st.view.y = panDrag.view.y + e.clientY - panDrag.y; clampView(); applyView(); return; }
    if (stroke && e.pointerId === stroke.id) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of (evs.length ? evs : [e])) { const [x, y] = toWorld(ce); painter.move(x, y, ce.pressure); }
      lastPen = performance.now();
    } else if (!stroke && (e.pointerType === 'pen' || e.pointerType === 'mouse')) {
      if (e.pointerType === 'pen') lastPen = performance.now();
      showHover(e);
    }
    return;
  }
  const t = touches.get(e.pointerId); if (!t) return;
  const r = sheet.getBoundingClientRect();
  t.x = e.clientX - r.left; t.y = e.clientY - r.top;
  if (tap && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > 12) tap.moved = true;
  if (pendingFinger && pendingFinger.id === e.pointerId) {
    pendingFinger.pts.push(toWorld(e));
    if (Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > 8 && touches.size === 1) { clearTimeout(pendingFinger.timer); const p = pendingFinger; pendingFinger = null; startStroke(p.e, 'eraser', true, p.pts); }
    return;
  }
  if (stroke && stroke.finger && stroke.id === e.pointerId) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of (evs.length ? evs : [e])) { const [x, y] = toWorld(ce); painter.move(x, y, 0); }
    return;
  }
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const pv = pinch.view, ns = Math.max(pv.fit * .8, Math.min(pv.fit * 10, pv.s * d / pinch.d));
    const wx = (pinch.mx - pv.x) / pv.s, wy = (pinch.my - pv.y) / pv.s;
    st.view = { ...pv, s: ns, x: mx - wx * ns, y: my - wy * ns };
    clampView(); applyView();
  }
});

function pointerEnd(e) {
  if (e.pointerType !== 'touch') {
    if (panDrag) { panDrag = null; return; }
    if (stroke && e.pointerId === stroke.id) endStroke();
    return;
  }
  touches.delete(e.pointerId);
  if (pendingFinger && pendingFinger.id === e.pointerId) { clearTimeout(pendingFinger.timer); pendingFinger = null; }
  if (stroke && stroke.finger && stroke.id === e.pointerId) endStroke();
  if (touches.size >= 2) pinchStart(); else pinch = null;
  if (touches.size === 0 && tap) {
    const quick = performance.now() - tap.t < 320 && !tap.moved;
    if (quick && tap.max === 2) doUndo();
    else if (quick && tap.max === 3) toggleEraser();
    tap = null;
  }
}
sheet.addEventListener('pointerup', pointerEnd);
sheet.addEventListener('pointercancel', e => {
  if (stroke && e.pointerId === stroke.id && e.pointerType === 'touch') { painter.cancel(); stroke = null; }
  pointerEnd(e);
});
sheet.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') hideHover(); });
sheet.addEventListener('wheel', e => {
  e.preventDefault();
  const r = sheet.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, st.view.s * Math.exp(-e.deltaY * .01));
  else { st.view.x -= e.deltaX; st.view.y -= e.deltaY; clampView(); applyView(); }
}, { passive: false });
// iOS 확대 제스처 기본동작 차단
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1 || e.target.closest('#sheet')) e.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', e => e.preventDefault());

document.addEventListener('keydown', e => {
  if (e.target.closest('textarea,input')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (e.key === 'e') toggleEraser();
});

/* ================= 자동 저장 ================= */
let saveT = 0, saving = null, dirty = false;
function scheduleSave() { dirty = true; clearTimeout(saveT); saveT = setTimeout(saveNow, 1500); }
async function saveNow() {
  clearTimeout(saveT);
  if (saving) { await saving; }
  if (!st.design) return;
  dirty = false;
  saving = (async () => {
    try { const blob = await painter.toBlob(); await store.set('paint', { id: st.design.id, blob, at: Date.now() }); }
    catch (err) { console.warn(err); }
  })();
  await saving; saving = null;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) saveNow(); });
addEventListener('pagehide', () => { if (dirty) saveNow(); });

/* ================= 새 도안 ================= */
const modal = $('newModal');
const show = (el, on) => { el.hidden = !on; };
function openModal() {
  show(modal, true); show($('choices'), true); show($('aiBox'), false); show($('setBox'), false); show($('busy'), false);
  [...$('detailSeg').children].forEach(b => b.classList.toggle('on', +b.dataset.v === st.detail));
}
function closeModal() { show(modal, false); $('fileInput').value = ''; }
$('newBtn').onclick = openModal;
$('closeModal').onclick = closeModal;
modal.addEventListener('pointerdown', e => { if (e.target === modal && $('busy').hidden) closeModal(); });
$('detailSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; st.detail = +b.dataset.v; P.set('detail', st.detail); openModalSeg(); };
function openModalSeg() { [...$('detailSeg').children].forEach(b => b.classList.toggle('on', +b.dataset.v === st.detail)); }
$('settingsBtn').onclick = () => {
  const on = $('setBox').hidden;
  show($('setBox'), on); show($('choices'), !on && $('aiBox').hidden); if (on) show($('aiBox'), false);
  $('apiKey').value = P.get('apiKey', ''); $('apiModel').value = P.get('model', DEFAULT_MODEL);
};
$('keyEye').onclick = () => $('apiKey').classList.toggle('masked');
$('setSave').onclick = () => {
  P.set('apiKey', $('apiKey').value.replace(/\s+/g, '')); P.set('model', $('apiModel').value.trim() || DEFAULT_MODEL);
  show($('setBox'), false); show($('choices'), true); toast('저장했어요');
};
$('aiChoice').onclick = () => {
  if (!P.get('apiKey', '')) { $('settingsBtn').onclick(); toast('Google API 키를 넣어주세요'); return; }
  show($('choices'), false); show($('aiBox'), true); setTimeout(() => $('prompt').focus(), 50);
};
$('aiBack').onclick = () => { show($('aiBox'), false); show($('choices'), true); };

const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
async function decodeImage(blob) {
  // 1) ImageBitmap  2) <img> (HEIC 등은 Safari가 <img>로만 읽는 경우가 있음)
  // 큰 사진은 디코딩하면서 바로 줄여 메모리를 아낌
  try { const b = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: 2048, resizeQuality: 'high' }); if (b.width > 0 && b.height > 0) return b; } catch {}
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
  try { return await createImageBitmap(blob); } catch {}
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await (img.decode ? img.decode() : new Promise((ok, no) => { img.onload = ok; img.onerror = no; }));
    if (!img.naturalWidth) throw new Error();
    return img;
  } catch {
    throw new Error(/hei[cf]/i.test(blob.type || blob.name || '') ? 'HEIC 사진을 읽지 못했어요. JPEG로 바꿔서 올려주세요' : '이미지를 읽지 못했어요');
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}
async function fromBlob(blob) {
  show($('busy'), true);
  P.set('processing', Date.now());
  await nextFrame();
  try {
    const src = await decodeImage(blob);
    await nextFrame();
    const d = await imageToDesign(src, st.detail);
    if (src.close) src.close();
    await applyDesign(d, null, { fresh: true });
    closeModal();
  } catch (err) { console.error(err); toast(err.message || '이미지를 처리하지 못했어요', 4000); }
  finally { P.set('processing', 0); show($('busy'), false); $('fileInput').value = ''; }
}
const onFile = e => { const f = e.target.files && e.target.files[0]; if (f) fromBlob(f); };
$('fileInput').addEventListener('change', onFile);
$('aiGo').onclick = async () => {
  const prompt = $('prompt').value.trim(); if (!prompt) { $('prompt').focus(); return; }
  show($('busy'), true);
  try {
    const blob = await generateImage(prompt, P.get('apiKey', ''), P.get('model', DEFAULT_MODEL));
    await fromBlob(blob);
  } catch (err) { console.error(err); toast(err.message, 4000); show($('busy'), false); }
};

/* ================= 기타 ================= */
let toastT = 0;
function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

/* ================= 시작 ================= */
(async function init() {
  const pp = paper();
  Object.assign($('paper').style, { backgroundImage: `url(${pp.url})`, backgroundSize: `${TILE}px ${TILE}px` });
  setBrush(st.brush);
  let d = null, paint = null;
  try {
    d = await store.get('design');
    const p = await store.get('paint');
    if (d && p && p.id === d.id) paint = p.blob;
  } catch (err) { console.warn(err); }
  const crashed = Date.now() - P.get('processing', 0) < 10 * 60 * 1000;
  P.set('processing', 0);
  if (d && d.reg && d.labels) await applyDesign(d, paint);
  else await applyDesign(sceneDesign(), null, { fresh: true });
  if (crashed) toast('사진이 너무 커서 처리 중 다시 시작됐어요. 다른 사진이나 \'간단\'으로 시도해 주세요', 5000);
  window.__app = { st, painter, applyDesign, sceneDesign, saveNow, coverage };
})();
