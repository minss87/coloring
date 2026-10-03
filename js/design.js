// 번호 도안 엔진
// 색 인덱스 지도(그리드) → 영역 분리 · 잔조각 병합 → 벡터 선화 + 번호 위치
import { hexRgb } from './paper.js';

export const DETAIL = [
  { grid: 440, k: 10, minFrac: 0.0016 },
  { grid: 600, k: 14, minFrac: 0.0008 },
  { grid: 760, k: 20, minFrac: 0.00035 },
];

/* ---------------- 공통 파이프라인 ---------------- */

function components(idx, gw, gh) {
  const N = gw * gh, comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
  const sizes = [], colors = [];
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (comp[i] !== -1) continue;
    const c = idx[i]; let sp = 0, size = 0;
    stack[sp++] = i; comp[i] = n;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % gw, y = (p - x) / gw;
      if (x > 0 && comp[p - 1] === -1 && idx[p - 1] === c) { comp[p - 1] = n; stack[sp++] = p - 1; }
      if (x < gw - 1 && comp[p + 1] === -1 && idx[p + 1] === c) { comp[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && comp[p - gw] === -1 && idx[p - gw] === c) { comp[p - gw] = n; stack[sp++] = p - gw; }
      if (y < gh - 1 && comp[p + gw] === -1 && idx[p + gw] === c) { comp[p + gw] = n; stack[sp++] = p + gw; }
    }
    sizes.push(size); colors.push(c); n++;
  }
  return { comp, sizes, colors, n };
}

// 작은 조각을 가장 많이 맞닿은 이웃 색으로 흡수
function mergeSmall(idx, gw, gh, minArea, thin = 2.4) {
  for (let pass = 0; pass < 8; pass++) {
    const { comp, sizes, n } = components(idx, gw, gh);
    const lp = thin > 0 ? labelPoints(comp, gw, gh, n) : null;
    const small = [];
    for (let c = 0; c < n; c++) if (sizes[c] < minArea || (lp && lp[c].d < thin)) small.push(c);
    if (!small.length || n === 1) return;
    // 조각별 픽셀 목록 (CSR)
    const start = new Int32Array(n + 1);
    for (let i = 0; i < comp.length; i++) start[comp[i] + 1]++;
    for (let c = 0; c < n; c++) start[c + 1] += start[c];
    const fill = start.slice(0, n), pix = new Int32Array(comp.length);
    for (let i = 0; i < comp.length; i++) pix[fill[comp[i]]++] = i;
    small.sort((a, b) => sizes[a] - sizes[b]);
    const count = new Map();
    for (const c of small) {
      count.clear();
      const own = idx[pix[start[c]]];
      for (let k = start[c]; k < start[c + 1]; k++) {
        const p = pix[k], x = p % gw;
        const nb = [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, p >= gw ? p - gw : -1, p < comp.length - gw ? p + gw : -1];
        for (const q of nb) if (q >= 0 && comp[q] !== c) { const v = idx[q]; if (v !== own) count.set(v, (count.get(v) || 0) + 1); }
      }
      let best = -1, bc = 0;
      for (const [v, k] of count) if (k > bc) { bc = k; best = v; }
      if (best < 0) continue;
      for (let k = start[c]; k < start[c + 1]; k++) idx[pix[k]] = best;
    }
  }
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function chaikin(pts, closed, iters = 2) {
  for (let k = 0; k < iters; k++) {
    if (pts.length < 3) return pts;
    const out = closed ? [] : [pts[0]];
    const n = pts.length, m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      out.push([p[0] * .75 + q[0] * .25, p[1] * .75 + q[1] * .25], [p[0] * .25 + q[0] * .75, p[1] * .25 + q[1] * .75]);
    }
    if (!closed) out.push(pts[n - 1]);
    pts = out;
  }
  return pts;
}

// 영역 경계 → 매끈한 벡터 경로
function vectorize(reg, gw, gh, s) {
  const VW = gw + 1, V = VW * (gh + 1);
  const adj = new Int32Array(V * 4).fill(-1), deg = new Uint8Array(V);
  const add = (a, b) => { adj[a * 4 + deg[a]++] = b; adj[b * 4 + deg[b]++] = a; };
  for (let y = 0; y < gh; y++) for (let x = 1; x < gw; x++)
    if (reg[y * gw + x - 1] !== reg[y * gw + x]) add(y * VW + x, (y + 1) * VW + x);
  for (let y = 1; y < gh; y++) for (let x = 0; x < gw; x++)
    if (reg[(y - 1) * gw + x] !== reg[y * gw + x]) add(y * VW + x, y * VW + x + 1);
  const seen = new Uint8Array(V * 2);
  const ek = (a, b) => { const m = Math.min(a, b); return m * 2 + (Math.abs(a - b) === 1 ? 0 : 1); };
  const P = v => [v % VW, Math.floor(v / VW)];
  const chains = [];
  const walk = (v, u) => {
    const pts = [P(v), P(u)]; seen[ek(v, u)] = 1;
    let prev = v, cur = u;
    while (deg[cur] === 2) {
      let nx = adj[cur * 4] === prev ? adj[cur * 4 + 1] : adj[cur * 4];
      if (seen[ek(cur, nx)]) break;
      seen[ek(cur, nx)] = 1; pts.push(P(nx)); prev = cur; cur = nx;
      if (cur === v) break;
    }
    return pts;
  };
  for (let v = 0; v < V; v++) {
    if (!deg[v] || deg[v] === 2) continue;
    for (let k = 0; k < deg[v]; k++) { const u = adj[v * 4 + k]; if (!seen[ek(v, u)]) chains.push({ pts: walk(v, u), closed: false }); }
  }
  for (let v = 0; v < V; v++) {
    if (deg[v] !== 2) continue;
    const u = adj[v * 4];
    if (!seen[ek(v, u)]) { const pts = walk(v, u); pts.pop(); chains.push({ pts, closed: true }); }
  }
  let d = '';
  const f = n => (n * s).toFixed(1);
  for (const ch of chains) {
    let pts = ch.pts;
    if (ch.closed) {
      // 가장 먼 점에서 둘로 나눠 단순화 후 합침
      let far = 0, fd = -1;
      for (let i = 1; i < pts.length; i++) { const dd = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (dd > fd) { fd = dd; far = i; } }
      const a = rdp(pts.slice(0, far + 1), 1.4), b = rdp(pts.slice(far).concat([pts[0]]), 1.4);
      pts = chaikin(a.concat(b.slice(1, -1)), true, 3);
      d += `M${f(pts[0][0])} ${f(pts[0][1])}` + pts.slice(1).map(p => `L${f(p[0])} ${f(p[1])}`).join('') + 'Z';
    } else {
      pts = chaikin(rdp(pts, 1.4), false, 3);
      d += `M${f(pts[0][0])} ${f(pts[0][1])}` + pts.slice(1).map(p => `L${f(p[0])} ${f(p[1])}`).join('');
    }
  }
  return d;
}

// 영역 안쪽에서 가장 넓은 지점 = 번호 위치
function labelPoints(reg, gw, gh, nReg) {
  const N = gw * gh, D = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % gw, y = (i - x) / gw, r = reg[i];
    const edge = x === 0 || y === 0 || x === gw - 1 || y === gh - 1 ||
      reg[i - 1] !== r || reg[i + 1] !== r || reg[i - gw] !== r || reg[i + gw] !== r;
    D[i] = edge ? 1 : 1e9;
  }
  const S = Math.SQRT2;
  for (let y = 1; y < gh; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x, r = reg[i];
    let v = D[i];
    if (reg[i - 1] === r) v = Math.min(v, D[i - 1] + 1);
    if (reg[i - gw] === r) v = Math.min(v, D[i - gw] + 1);
    if (reg[i - gw - 1] === r) v = Math.min(v, D[i - gw - 1] + S);
    if (reg[i - gw + 1] === r) v = Math.min(v, D[i - gw + 1] + S);
    D[i] = v;
  }
  for (let y = gh - 2; y >= 0; y--) for (let x = gw - 2; x >= 1; x--) {
    const i = y * gw + x, r = reg[i];
    let v = D[i];
    if (reg[i + 1] === r) v = Math.min(v, D[i + 1] + 1);
    if (reg[i + gw] === r) v = Math.min(v, D[i + gw] + 1);
    if (reg[i + gw + 1] === r) v = Math.min(v, D[i + gw + 1] + S);
    if (reg[i + gw - 1] === r) v = Math.min(v, D[i + gw - 1] + S);
    D[i] = v;
  }
  const best = new Float32Array(nReg).fill(-1), at = new Int32Array(nReg);
  for (let i = 0; i < N; i++) { const r = reg[i]; if (D[i] > best[r]) { best[r] = D[i]; at[r] = i; } }
  return Array.from({ length: nReg }, (_, r) => ({ gx: at[r] % gw + 0.5, gy: Math.floor(at[r] / gw) + 0.5, d: best[r] }));
}

export function buildDesign({ idx, gw, gh, palette, w, h, minArea, extra = '', kind = 'image' }) {
  mergeSmall(idx, gw, gh, minArea);
  // 쓰인 색만 남기고 번호 다시 매김
  const used = new Uint8Array(palette.length);
  for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
  const remap = new Int16Array(palette.length).fill(-1), pal = [];
  palette.forEach((c, i) => { if (used[i]) { remap[i] = pal.length; pal.push(c); } });
  const { comp, colors, n } = components(idx, gw, gh);
  const reg = new Uint16Array(comp.length);
  for (let i = 0; i < comp.length; i++) reg[i] = comp[i];
  const regionNum = new Uint8Array(n);
  for (let r = 0; r < n; r++) regionNum[r] = remap[colors[r]];
  const s = w / gw;
  const path = vectorize(reg, gw, gh, s);
  const labels = labelPoints(reg, gw, gh, n).map(p => ({
    x: +(p.gx * s).toFixed(1), y: +(p.gy * s).toFixed(1), fs: +Math.max(10, Math.min(44, p.d * s * 1.05)).toFixed(1),
  }));
  return {
    id: 'd' + Date.now().toString(36), kind, w, h, gw, gh, palette: pal, reg, regionNum, labels, path, extra,
    lineWidth: Math.max(2.4, w / 700),
  };
}

/* ---------------- 이미지 → 색 인덱스 지도 ---------------- */

function srgb2lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function lin2srgb(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); }
function rgb2lab(r, g, b) {
  r = srgb2lin(r); g = srgb2lin(g); b = srgb2lin(b);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function lab2hex(L, A, B) {
  let y = (L + 16) / 116, x = A / 500 + y, z = y - B / 200;
  const fi = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  x = fi(x) * 0.95047; y = fi(y); z = fi(z) * 1.08883;
  const r = lin2srgb(x * 3.2406 + y * -1.5372 + z * -0.4986), g = lin2srgb(x * -0.9689 + y * 1.8758 + z * 0.0415), b = lin2srgb(x * 0.0557 + y * -0.2040 + z * 1.0570);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function imageToDesign(source, detail = 1) {
  const det = DETAIL[detail];
  const iw = source.naturalWidth || source.width, ih = source.naturalHeight || source.height;
  const asp = iw / ih;
  const w = asp >= 1 ? 2400 : Math.round(2400 * asp), h = asp >= 1 ? Math.round(2400 / asp) : 2400;
  const gw = asp >= 1 ? det.grid : Math.round(det.grid * asp), gh = asp >= 1 ? Math.round(det.grid / asp) : det.grid;

  // 단계적 축소 (부드럽게)
  let src = source, cw = iw, ch = ih;
  while (cw / 2 > gw * 1.5) {
    const c = document.createElement('canvas'); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    src = c; cw = c.width; ch = c.height;
  }
  const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, gw, gh);
  cx.imageSmoothingQuality = 'high'; cx.drawImage(src, 0, 0, gw, gh);
  const px = cx.getImageData(0, 0, gw, gh).data;
  const N = gw * gh;

  // Lab 변환 + 가벼운 블러
  const lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const l = rgb2lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2]; }
  const bl = new Float32Array(N * 3);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let a = 0, b = 0, c = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
      const j = (yy * gw + xx) * 3, wgt = dx || dy ? 1 : 2; a += lab[j] * wgt; b += lab[j + 1] * wgt; c += lab[j + 2] * wgt; k += wgt;
    }
    const i = (y * gw + x) * 3; bl[i] = a / k; bl[i + 1] = b / k; bl[i + 2] = c / k;
  }
  await new Promise(r => setTimeout(r));

  // k-means++ (표본)
  const K = det.k, sample = [], step = Math.max(1, Math.floor(N / 30000));
  for (let i = 0; i < N; i += step) sample.push(i);
  const C = new Float32Array(K * 3);
  let rs = 12345; const rnd = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
  const first = sample[Math.floor(rnd() * sample.length)];
  C.set(bl.subarray(first * 3, first * 3 + 3), 0);
  const dmin = new Float32Array(sample.length).fill(Infinity);
  for (let k = 1; k < K; k++) {
    let tot = 0;
    for (let s = 0; s < sample.length; s++) {
      const j = sample[s] * 3, c = (k - 1) * 3;
      const d = (bl[j] - C[c]) ** 2 + (bl[j + 1] - C[c + 1]) ** 2 + (bl[j + 2] - C[c + 2]) ** 2;
      if (d < dmin[s]) dmin[s] = d; tot += dmin[s];
    }
    let t = rnd() * tot, pick = sample[0];
    for (let s = 0; s < sample.length; s++) { t -= dmin[s]; if (t <= 0) { pick = sample[s]; break; } }
    C.set(bl.subarray(pick * 3, pick * 3 + 3), k * 3);
  }
  const nearest = j => { let bi = 0, bd = Infinity; for (let k = 0; k < K; k++) { const c = k * 3; const d = (bl[j] - C[c]) ** 2 + (bl[j + 1] - C[c + 1]) ** 2 + (bl[j + 2] - C[c + 2]) ** 2; if (d < bd) { bd = d; bi = k; } } return bi; };
  for (let it = 0; it < 14; it++) {
    const sum = new Float64Array(K * 3), cnt = new Float64Array(K);
    for (const i of sample) { const k = nearest(i * 3); sum[k * 3] += bl[i * 3]; sum[k * 3 + 1] += bl[i * 3 + 1]; sum[k * 3 + 2] += bl[i * 3 + 2]; cnt[k]++; }
    for (let k = 0; k < K; k++) if (cnt[k]) { C[k * 3] = sum[k * 3] / cnt[k]; C[k * 3 + 1] = sum[k * 3 + 1] / cnt[k]; C[k * 3 + 2] = sum[k * 3 + 2] / cnt[k]; }
  }
  await new Promise(r => setTimeout(r));
  let idx = new Uint8Array(N);
  for (let i = 0; i < N; i++) idx[i] = nearest(i * 3);

  // 최빈값 필터 2회 (자잘한 점 제거)
  for (let pass = 0; pass < 2; pass++) {
    const o = new Uint8Array(N), cnt = new Uint8Array(K);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      cnt.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue; cnt[idx[yy * gw + xx]]++;
      }
      let b = idx[y * gw + x], bc = cnt[b];
      for (let k = 0; k < K; k++) if (cnt[k] > bc) { bc = cnt[k]; b = k; }
      o[y * gw + x] = b;
    }
    idx = o;
  }

  // 팔레트: 색상환 → 밝기 순
  const cols = Array.from({ length: K }, (_, k) => {
    const L = C[k * 3], A = C[k * 3 + 1], B = C[k * 3 + 2], chroma = Math.hypot(A, B);
    const hue = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
    return { k, hex: lab2hex(L, A, B), key: chroma < 10 ? 1000 + (100 - L) : Math.floor(((hue + 20) % 360) / 30) * 100 + (100 - L) };
  }).sort((a, b) => a.key - b.key);
  const order = new Uint8Array(K); cols.forEach((c, i) => { order[c.k] = i; });
  for (let i = 0; i < N; i++) idx[i] = order[idx[i]];
  await new Promise(r => setTimeout(r));
  return buildDesign({ idx, gw, gh, palette: cols.map(c => c.hex), w, h, minArea: Math.max(12, det.minFrac * N) });
}

/* ---------------- 기본 풍경 도안 (오프라인) ---------------- */

class Shape {
  constructor(color) { this.p = new Path2D(); this.color = color; this.x0 = Infinity; this.y0 = Infinity; this.x1 = -Infinity; this.y1 = -Infinity; }
  _b(x, y) { if (x < this.x0) this.x0 = x; if (y < this.y0) this.y0 = y; if (x > this.x1) this.x1 = x; if (y > this.y1) this.y1 = y; }
  M(x, y) { this.p.moveTo(x, y); this._b(x, y); return this; }
  L(x, y) { this.p.lineTo(x, y); this._b(x, y); return this; }
  Q(cx, cy, x, y) { this.p.quadraticCurveTo(cx, cy, x, y); this._b(cx, cy); this._b(x, y); return this; }
  E(cx, cy, rx, ry, rot = 0) { this.p.moveTo(cx + rx * Math.cos(rot), cy + rx * Math.sin(rot)); this.p.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2); const m = Math.max(rx, ry); this._b(cx - m, cy - m); this._b(cx + m, cy + m); return this; }
  Z() { this.p.closePath(); return this; }
  poly(pts) { pts.forEach(([x, y], i) => i ? this.L(x, y) : this.M(x, y)); return this.Z(); }
}

const SCENE_PAL = ['#9CC6EE', '#F6C631', '#E4E8EF', '#7F8FD6', '#8BC34A', '#1FA3B5', '#E0403A', '#F07B2E', '#25A06A', '#E8D8C4', '#E9649F', '#8657CC', '#B9D86A', '#8A5A44', '#5E6FBF', '#F3A6C4'];
const [SKY, SUN, CLOUD, MTN, HILL, RIVER, ROOF1, ROOF2, TREE, WALL, PINK, PURPLE, FIELD, BROWN, MTN2, LIGHTPINK] = SCENE_PAL.map((_, i) => i);

export function sceneDesign(seed = Date.now()) {
  let s = (seed % 2147483646) + 1; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const R = (a, b) => a + r() * (b - a);
  const W = 2400, H = 1600, shapes = [], ex = [];
  const add = c => { const sh = new Shape(c); shapes.push(sh); return sh; };
  const line = d => ex.push(d);

  add(SKY).poly([[0, 0], [W, 0], [W, H], [0, H]]);
  // 해
  const sx = R(300, 2100), sy = R(230, 420), sr = R(85, 120);
  add(SUN).E(sx, sy, sr, sr);
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; line(`M${(sx + Math.cos(a) * (sr + 30)).toFixed(1)} ${(sy + Math.sin(a) * (sr + 30)).toFixed(1)}L${(sx + Math.cos(a) * (sr + 82)).toFixed(1)} ${(sy + Math.sin(a) * (sr + 82)).toFixed(1)}`); }
  // 구름
  const nc = 3 + Math.floor(r() * 3);
  for (let c = 0; c < nc; c++) {
    let cx = R(150, 2250), cy = R(150, 560);
    if (Math.hypot(cx - sx, cy - sy) < sr + 200) cx = (cx + 900) % 2200 + 100;
    const cw = R(180, 340), cl = add(CLOUD), nb = 3 + Math.floor(r() * 3);
    for (let i = 0; i < nb; i++) { const bx = cx - cw / 2 + (i + .5) * cw / nb, br = cw / nb * R(.55, .85); cl.E(bx, cy - br * .35, br, br * R(.8, 1)); }
    cl.E(cx, cy + 4, cw * .52, cw * .16);
  }
  // 새
  for (let i = 0; i < 4; i++) { const bx = R(200, 2200), by = R(120, 480); line(`M${(bx - 18).toFixed(0)} ${by.toFixed(0)}q9 -12 18 0q9 -12 18 0`); }

  // 산 (두 겹)
  const ridge = (base, amp, n) => { const pts = [[0, base + R(-40, 40)]]; for (let i = 1; i < n; i++) pts.push([i * W / n + R(-60, 60), base - (i % 2 ? amp * R(.6, 1.1) : amp * R(.05, .35))]); pts.push([W, base + R(-40, 40)]); return pts; };
  const back = ridge(860, 380, 9);
  add(MTN2).poly([...back, [W, 1300], [0, 1300]]);
  const front = ridge(930, 300, 7);
  add(MTN).poly([...front, [W, 1300], [0, 1300]]);
  for (const ridgePts of [back, front]) for (const [px, py] of ridgePts) {
    if (py > 620 || px < 40 || px > W - 40) continue;
    const sc = add(CLOUD), dw = 70;
    sc.poly([[px, py], [px + dw, py + dw * 1.1], [px + dw * .45, py + dw * .85], [px + dw * .1, py + dw * 1.15], [px - dw * .3, py + dw * .8], [px - dw * .7, py + dw * 1.05]]);
  }

  // 언덕 / 들판 높이 함수
  const ph = [R(0, 6), R(0, 6), R(0, 6)], pf = [R(0, 6), R(0, 6)];
  const yHill = x => 1000 + Math.sin(x / 380 + ph[0]) * 55 + Math.sin(x / 170 + ph[1]) * 18 + Math.sin(x / 900 + ph[2]) * 40;
  const yField = x => 1210 + Math.sin(x / 450 + pf[0]) * 60 + Math.sin(x / 210 + pf[1]) * 20;
  const curve = (f, bottom) => { const pts = []; for (let x = 0; x <= W; x += 30) pts.push([x, f(x)]); pts.push([W, bottom], [0, bottom]); return pts; };
  add(HILL).poly(curve(yHill, H));

  // 강
  const hasRiver = r() < .8, rx = R(700, 1700), rb = R(rx - 350, rx + 350);
  const riverX = t => rx + (rb - rx) * t + Math.sin(t * 5 + ph[0]) * 90 * t;
  if (hasRiver) {
    const y0 = yHill(rx) + 8, L = [], Rr = [];
    for (let t = 0; t <= 1.0001; t += 0.05) { const y = y0 + (H - y0) * t, cx = riverX(t), half = 25 + 165 * t; L.push([cx - half, y]); Rr.push([cx + half, y]); }
    add(RIVER).poly([...L, ...Rr.reverse()]);
    for (let i = 0; i < 6; i++) { const t = .15 + i * .14, y = y0 + (H - y0) * t, cx = riverX(t) + R(-30, 30); line(`M${(cx - 40).toFixed(0)} ${y.toFixed(0)}q10 -8 20 0t20 0t20 0`); }
  }
  const inRiver = (x, y) => { if (!hasRiver) return false; const y0 = yHill(rx) + 8; if (y < y0 - 40) return false; const t = Math.max(0, (y - y0) / (H - y0)); return Math.abs(x - riverX(t)) < 25 + 165 * t + 90; };

  // 집
  const houses = [];
  const nh = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nh * 4 && houses.length < nh; i++) {
    const x = R(120, W - 260), w = R(100, 140), y = yHill(x + w / 2) + R(-10, 30);
    if (inRiver(x + w / 2, y) || houses.some(h => Math.abs(h - x) < 220)) continue;
    houses.push(x);
    const h = w * .72, rc = r() < .5 ? ROOF1 : ROOF2;
    add(WALL).poly([[x, y - h], [x + w, y - h], [x + w, y], [x, y]]);
    add(rc).poly([[x - 16, y - h], [x + w / 2, y - h - w * .55], [x + w + 16, y - h]]);
    add(BROWN).poly([[x + w * .58, y - h * .62], [x + w * .82, y - h * .62], [x + w * .82, y], [x + w * .58, y]]);
    const wx = x + w * .14, wy = y - h * .7, ww = w * .26, wh = w * .22;
    add(SKY).poly([[wx, wy], [wx + ww, wy], [wx + ww, wy + wh], [wx, wy + wh]]);
    line(`M${(wx + ww / 2).toFixed(1)} ${wy.toFixed(1)}v${wh.toFixed(1)}M${wx.toFixed(1)} ${(wy + wh / 2).toFixed(1)}h${ww.toFixed(1)}`);
  }
  // 나무
  const nt = 6 + Math.floor(r() * 6);
  for (let i = 0; i < nt; i++) {
    const x = R(60, W - 60), sc = R(.75, 1.25), y = yHill(x) + R(-5, 45);
    if (inRiver(x, y) || houses.some(h => x > h - 60 && x < h + 200)) continue;
    if (r() < .65) {
      add(TREE).poly([[x, y - 150 * sc], [x + 46 * sc, y - 80 * sc], [x + 24 * sc, y - 80 * sc], [x + 60 * sc, y - 20 * sc], [x - 60 * sc, y - 20 * sc], [x - 24 * sc, y - 80 * sc], [x - 46 * sc, y - 80 * sc]]);
      add(BROWN).poly([[x - 8 * sc, y - 20 * sc], [x + 8 * sc, y - 20 * sc], [x + 8 * sc, y + 6 * sc], [x - 8 * sc, y + 6 * sc]]);
    } else {
      add(BROWN).poly([[x - 9 * sc, y - 50 * sc], [x + 9 * sc, y - 50 * sc], [x + 9 * sc, y + 6 * sc], [x - 9 * sc, y + 6 * sc]]);
      const t = add(TREE); t.E(x, y - 100 * sc, 52 * sc, 48 * sc); t.E(x - 34 * sc, y - 72 * sc, 32 * sc, 28 * sc); t.E(x + 34 * sc, y - 74 * sc, 32 * sc, 28 * sc);
    }
  }
  // 앞 들판
  add(FIELD).poly(curve(yField, H));
  if (hasRiver) {
    const y0 = yHill(rx) + 8, L = [], Rr = [];
    for (let t = 0; t <= 1.0001; t += 0.05) { const y = y0 + (H - y0) * t, cx = riverX(t), half = 25 + 165 * t; if (y < yField(cx) - 60) continue; L.push([cx - half, y]); Rr.push([cx + half, y]); }
    if (L.length > 1) add(RIVER).poly([...L, ...Rr.reverse()]);
  }
  // 꽃
  const nf = 7 + Math.floor(r() * 6);
  for (let i = 0; i < nf; i++) {
    const x = R(80, W - 80), sc = R(.9, 1.35), y = R(yField(x) + 90, H - 80);
    if (inRiver(x, y)) continue;
    line(`M${x.toFixed(1)} ${(y + 16 * sc).toFixed(1)}Q${(x - 8 * sc).toFixed(1)} ${(y + 60 * sc).toFixed(1)} ${x.toFixed(1)} ${(y + 110 * sc).toFixed(1)}`);
    add(TREE).poly([[x - 2 * sc, y + 70 * sc], [x - 26 * sc, y + 58 * sc], [x - 46 * sc, y + 36 * sc], [x - 20 * sc, y + 44 * sc]]);
    const pc = [PINK, PURPLE, ROOF1, LIGHTPINK, ROOF2][Math.floor(r() * 5)];
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; add(pc).E(x + Math.cos(a) * 26 * sc, y + Math.sin(a) * 26 * sc, 20 * sc, 13 * sc, a); }
    add(SUN).E(x, y, 14 * sc, 14 * sc);
  }
  // 풀
  for (let i = 0; i < 45; i++) { const x = R(0, W), y = R(yField(x) + 40, H - 10); if (inRiver(x, y)) continue; line(`M${x.toFixed(0)} ${y.toFixed(0)}q-4 -14 -12 -22M${x.toFixed(0)} ${y.toFixed(0)}q0 -18 3 -30M${x.toFixed(0)} ${y.toFixed(0)}q5 -12 14 -18`); }

  // 래스터화: 도형마다 알파 50% 기준으로 칸 지정 (안티앨리어싱 잔선 없음)
  const gw = 960, gh = 640, g = gw / W;
  const idx = new Uint8Array(gw * gh);
  const mc = document.createElement('canvas'); mc.width = gw; mc.height = gh;
  const m = mc.getContext('2d', { willReadFrequently: true });
  for (const sh of shapes) {
    const bx = Math.max(0, Math.floor(sh.x0 * g) - 1), by = Math.max(0, Math.floor(sh.y0 * g) - 1);
    const bw = Math.min(gw, Math.ceil(sh.x1 * g) + 2) - bx, bh = Math.min(gh, Math.ceil(sh.y1 * g) + 2) - by;
    if (bw <= 0 || bh <= 0) continue;
    m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(bx, by, bw, bh);
    m.setTransform(g, 0, 0, g, 0, 0); m.fillStyle = '#000'; m.fill(sh.p);
    const a = m.getImageData(bx, by, bw, bh).data;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (a[(y * bw + x) * 4 + 3] >= 128) idx[(by + y) * gw + bx + x] = sh.color;
  }
  return buildDesign({ idx, gw, gh, palette: SCENE_PAL, w: W, h: H, minArea: 20, extra: ex.join(''), kind: 'scene' });
}

export function hexLum(h) { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
