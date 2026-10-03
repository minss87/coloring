// 도화지 질감: 이음새 없는 높이맵 하나로 배경 무늬와 색연필 입자를 같이 만든다.
export const TILE = 512; // 월드 단위 타일 크기

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// 주기적 값 노이즈 (타일 경계에서 이어짐)
function periodicNoise(size, cells, rand) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(size * size);
  const step = size / cells;
  for (let y = 0; y < size; y++) {
    const fy = y / step, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x / step, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells, c1 = (x0 + 1) % cells;
      const a = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
      const b = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(size, octaves, seed) {
  const rand = rng(seed);
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [cells, w] of octaves) {
    const n = periodicNoise(size, cells, rand);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w;
    total += w;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) { const v = out[i] / total; out[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn);
  return out;
}

let cache = null;
export function paper() {
  if (cache) return cache;
  const N = TILE;
  // 도화지 요철: 잘고 거친 결 위주
  const tooth = fbm(N, [[256, 1], [128, 0.9], [64, 0.55], [32, 0.25]], 11);
  // 펄프 뭉침: 넓고 약한 얼룩
  const pulp = fbm(N, [[4, 1], [8, 0.6], [16, 0.35]], 23);
  // 수채화 얼룩용
  const blot = fbm(N, [[4, 1], [8, 0.7], [16, 0.4], [32, 0.15]], 37);

  // 배경 타일: 측면광 음영 (무채색)
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N), d = img.data;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const l = tooth[y * N + ((x + N - 1) % N)], r = tooth[y * N + ((x + 1) % N)];
    const u = tooth[((y + N - 1) % N) * N + x], b = tooth[((y + 1) % N) * N + x];
    const shade = ((l - r) + (u - b)) * 0.5;       // 왼쪽 위에서 오는 빛
    let v = 251 + shade * 34 - (1 - tooth[i]) * 5 - (pulp[i] - 0.5) * 7;
    v = Math.max(0, Math.min(255, v));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cache = { tooth, blot, url: cv.toDataURL('image/png'), size: N };
  return cache;
}

// 색연필: 압력 단계별로 '종이 봉우리에만 묻는' 패턴
const grainCache = new Map();
export function pencilPatterns(ctx, hex, scale, levels = 6) {
  const key = hex + '|' + scale + '|' + levels;
  if (grainCache.has(key)) return grainCache.get(key);
  const { tooth, size } = paper();
  const [r, g, b] = hexRgb(hex);
  const pats = [];
  for (let L = 0; L < levels; L++) {
    const p = (L + 1) / levels;               // 0..1 압력
    const thr = 0.84 - p * 0.68;              // 높은 압력 → 골짜기까지 묻음
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const c = cv.getContext('2d'), im = c.createImageData(size, size), d = im.data;
    for (let i = 0; i < tooth.length; i++) {
      const a = Math.max(0, Math.min(1, (tooth[i] - thr) / 0.22));
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a * 255;
    }
    c.putImageData(im, 0, 0);
    const pat = ctx.createPattern(cv, 'repeat');
    pat.setTransform(new DOMMatrix().scale(scale));
    pats.push(pat);
  }
  if (grainCache.size > 3) grainCache.delete(grainCache.keys().next().value);
  grainCache.set(key, pats);
  return pats;
}

// 수채화 얼룩 (알파만)
let blotPat = null;
export function blotPattern(ctx, scale) {
  if (blotPat && blotPat.scale === scale) return blotPat.pat;
  const { blot, size } = paper();
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d'), im = c.createImageData(size, size), d = im.data;
  for (let i = 0; i < blot.length; i++) { d[i * 4 + 3] = (0.5 + blot[i] * 0.5) * 255; }
  c.putImageData(im, 0, 0);
  const pat = ctx.createPattern(cv, 'repeat');
  pat.setTransform(new DOMMatrix().scale(scale * 1.6));
  blotPat = { scale, pat };
  return pat;
}

export function hexRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
}
