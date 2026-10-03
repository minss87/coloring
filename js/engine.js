// 드로잉 엔진: 스탬프 방식 브러시 + 획 단위 되돌리기
import { pencilPatterns, blotPattern, hexRgb } from './paper.js?v=8';

export const BRUSHES = [['pencil', '색연필'], ['oil', '유화'], ['marker', '마커'], ['fine', '세필 마커'], ['wc', '수채화'], ['eraser', '지우개']];

const CFG = {
  pencil: { mul: .5,  spacing: .12, blend: 'multiply', alpha: 1 },
  oil:    { mul: 1.0, spacing: .09, blend: 'normal',   alpha: 1 },
  marker: { mul: 1.0, spacing: .08, blend: 'multiply', alpha: .6 },
  fine:   { mul: .28, spacing: .1,  blend: 'normal',   alpha: 1 },
  wc:     { mul: 1.5, spacing: .1,  blend: 'multiply', alpha: .62 },
  eraser: { mul: 1.0, spacing: .12 },
};
// 굵기 1~40 → 월드 단위 지름
export const diameter = (size, brush) => (4 + size * 2.2) * CFG[brush].mul;

const MAX_UNDO_BYTES = 160 * 1024 * 1024, MAX_UNDO = 60;
const canFilter = (() => { try { const c = document.createElement('canvas').getContext('2d'); c.filter = 'blur(2px)'; return c.filter === 'blur(2px)'; } catch { return false; } })();

function shade(hex, f) { // f: -1..1 밝기 변화
  const [r, g, b] = hexRgb(hex);
  const t = f < 0 ? 0 : 255, a = Math.abs(f);
  return `rgb(${Math.round(r + (t - r) * a)},${Math.round(g + (t - g) * a)},${Math.round(b + (t - b) * a)})`;
}

export class Painter {
  constructor(paint, live) {
    this.paint = paint; this.live = live;
    this.pc = paint.getContext('2d', { willReadFrequently: false });
    this.lc = live.getContext('2d');
    this.backup = document.createElement('canvas');
    this.bc = this.backup.getContext('2d', { willReadFrequently: true });
    this.undoStack = []; this.redoStack = []; this.bytes = 0;
    this.onHistory = () => {};
  }

  setup(w, h) {
    this.w = w; this.h = h;
    this.k = Math.min(1.2, Math.sqrt(4.6e6 / (w * h)));
    const W = Math.round(w * this.k), H = Math.round(h * this.k);
    for (const c of [this.paint, this.live, this.backup]) { c.width = W; c.height = H; }
    for (const c of [this.paint, this.live]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
    this.W = W; this.H = H;
    this.undoStack = []; this.redoStack = []; this.bytes = 0; this.onHistory();
  }

  async load(blob) {
    this.pc.clearRect(0, 0, this.W, this.H);
    if (!blob) return;
    const bmp = await createImageBitmap(blob);
    this.pc.drawImage(bmp, 0, 0, this.W, this.H);
    bmp.close && bmp.close();
  }

  toBlob() { return new Promise(r => this.paint.toBlob(r, 'image/png')); }

  /* ---------- 획 ---------- */
  begin(o, x, y, pressure, isPen) {
    const brush = o.brush;
    this.s = {
      brush, color: o.color, op: o.opacity, D: diameter(o.size, brush) * this.k,
      x: x * this.k, y: y * this.k, sx: x * this.k, sy: y * this.k, ps: this.autoPressure(pressure, isPen, brush),
      isPen, carry: 0, travel: 0, ang: 0,
      x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
    };
    const s = this.s;
    this.bc.clearRect(0, 0, this.W, this.H);
    this.bc.drawImage(this.paint, 0, 0);
    if (brush === 'eraser') { this.ctx = this.pc; }
    else {
      this.ctx = this.lc;
      const cfg = CFG[brush];
      this.live.style.opacity = String(cfg.alpha * s.op);
      this.live.style.mixBlendMode = cfg.blend;
      if (brush === 'pencil') s.pats = pencilPatterns(this.lc, o.color, this.k, 8);
      if (brush === 'oil') {
        let seed = Math.random() * 1e9 | 0; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const n = 11;
        s.bristles = Array.from({ length: n }, (_, i) => ({
          o: (i / (n - 1)) * 2 - 1 + (rnd() - .5) * .12,
          c: shade(o.color, i % 4 === 1 ? .2 + rnd() * .1 : (rnd() - .55) * .22),
          w: .8 + rnd() * .5,
        }));
      }
    }
    this.stamp(s.x, s.y);
  }

  autoPressure(p, isPen, brush) {
    if (brush === 'pencil') {
      // 색연필: 필압을 제대로 반영 (살살 → 연하고 가늘게, 꾹 → 진하고 굵게)
      if (!isPen || !(p > 0)) return .62;
      return Math.min(1, .12 + .88 * Math.min(1, p / .9));
    }
    // 나머지: 살짝만 반영 → 대부분 0.75~1 사이로 안정
    if (!isPen || !(p > 0)) return .82;
    return .62 + .38 * Math.pow(Math.min(1, p / .6), .7);
  }

  move(x, y, pressure) {
    const s = this.s; if (!s) return;
    const tx = x * this.k, ty = y * this.k;
    // 손떨림 보정
    s.sx += (tx - s.sx) * .6; s.sy += (ty - s.sy) * .6;
    s.ps += (this.autoPressure(pressure, s.isPen, s.brush) - s.ps) * (s.brush === 'pencil' ? .3 : .18);
    const dx = s.sx - s.x, dy = s.sy - s.y, len = Math.hypot(dx, dy);
    if (len < .01) return;
    s.ang = Math.atan2(dy, dx);
    let pos = s.carry;
    const step = () => Math.max(.6, this.radius() * 2 * CFG[s.brush].spacing);
    let sp = step();
    while (pos + sp <= len) {
      pos += sp;
      const t = pos / len;
      s.travel += sp;
      this.stamp(s.x + dx * t, s.y + dy * t);
      sp = step();
    }
    s.carry = pos - len;
    s.x = s.sx; s.y = s.sy;
  }

  radius() {
    const s = this.s, taper = Math.min(1, .4 + .6 * s.travel / (s.D * 1.2));
    const base = s.D / 2;
    switch (s.brush) {
      case 'pencil': return base * (.5 + .5 * s.ps) * taper;
      case 'oil': return base * (.72 + .28 * s.ps) * Math.min(1, .7 + .3 * taper);
      case 'marker': return base * Math.min(1, .85 + .15 * taper);
      case 'fine': return base * (.8 + .2 * s.ps) * Math.min(1, .55 + .45 * taper);
      case 'wc': return base * (.7 + .3 * s.ps) * taper;
      default: return base;
    }
  }

  stamp(x, y) {
    const s = this.s, c = this.ctx, r = Math.max(.6, this.radius());
    const pad = r * 1.2 + 2;
    if (x - pad < s.x0) s.x0 = x - pad; if (y - pad < s.y0) s.y0 = y - pad;
    if (x + pad > s.x1) s.x1 = x + pad; if (y + pad > s.y1) s.y1 = y + pad;
    c.save();
    switch (s.brush) {
      case 'pencil': {
        const lv = Math.max(0, Math.min(s.pats.length - 1, Math.round(s.ps * (s.pats.length - 1))));
        c.globalAlpha = .28 + .42 * s.ps; c.fillStyle = s.pats[lv];
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        break;
      }
      case 'oil': {
        const px = -Math.sin(s.ang), py = Math.cos(s.ang), br = r * .2;
        for (const b of s.bristles) {
          c.fillStyle = b.c;
          c.beginPath(); c.arc(x + px * b.o * r, y + py * b.o * r, br * b.w, 0, Math.PI * 2); c.fill();
        }
        break;
      }
      case 'fine': {
        c.fillStyle = s.color;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        break;
      }
      case 'marker': {
        c.translate(x, y); c.rotate(-Math.PI / 5); c.fillStyle = s.color;
        c.beginPath();
        if (c.roundRect) c.roundRect(-r, -r * .36, r * 2, r * .72, r * .18); else c.rect(-r, -r * .36, r * 2, r * .72);
        c.fill();
        break;
      }
      case 'wc': {
        const [R, G, B] = hexRgb(s.color);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${R},${G},${B},1)`); g.addColorStop(.6, `rgba(${R},${G},${B},.8)`); g.addColorStop(1, `rgba(${R},${G},${B},0)`);
        c.globalAlpha = .28; c.fillStyle = g;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        break;
      }
      case 'eraser': {
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(.75, 'rgba(0,0,0,.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.globalCompositeOperation = 'destination-out'; c.fillStyle = g;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        break;
      }
    }
    c.restore();
  }

  end() {
    const s = this.s; if (!s) return null;
    this.s = null;
    const bx = Math.max(0, Math.floor(s.x0)), by = Math.max(0, Math.floor(s.y0));
    const bw = Math.min(this.W, Math.ceil(s.x1)) - bx, bh = Math.min(this.H, Math.ceil(s.y1)) - by;
    if (bw <= 0 || bh <= 0) return null;
    const before = this.bc.getImageData(bx, by, bw, bh);
    if (s.brush !== 'eraser') this.commit(s, bx, by, bw, bh);
    const after = this.pc.getImageData(bx, by, bw, bh);
    this.lc.clearRect(bx, by, bw, bh);
    this.push({ bx, by, bw, bh, before, after });
    return { x: bx / this.k, y: by / this.k, w: bw / this.k, h: bh / this.k };
  }

  cancel() { // 손가락이 제스처로 바뀌었을 때
    const s = this.s; if (!s) return;
    this.s = null;
    this.lc.clearRect(0, 0, this.W, this.H);
    if (s.brush === 'eraser') { this.pc.clearRect(0, 0, this.W, this.H); this.pc.drawImage(this.backup, 0, 0); }
  }

  commit(s, bx, by, bw, bh) {
    const p = this.pc, cfg = CFG[s.brush];
    const comp = cfg.blend === 'multiply' ? 'multiply' : 'source-over';
    if (s.brush === 'fine') {
      // 같은 색끼리는 겹쳐도 진해지지 않음: 같은 색 위에서는 더 진한 쪽만 남김
      const src = this.lc.getImageData(bx, by, bw, bh).data;
      const im = p.getImageData(bx, by, bw, bh), dst = im.data;
      const [R, G, B] = hexRgb(s.color), op = s.op;
      for (let i = 0; i < src.length; i += 4) {
        const sa = src[i + 3] / 255 * op; if (sa <= 0) continue;
        const da = dst[i + 3] / 255;
        const same = da > 0 && Math.abs(dst[i] - R) + Math.abs(dst[i + 1] - G) + Math.abs(dst[i + 2] - B) < 24;
        if (same || da === 0) { dst[i] = R; dst[i + 1] = G; dst[i + 2] = B; dst[i + 3] = Math.max(dst[i + 3], sa * 255); }
        else {
          const oa = sa + da * (1 - sa);
          dst[i] = (R * sa + dst[i] * da * (1 - sa)) / oa; dst[i + 1] = (G * sa + dst[i + 1] * da * (1 - sa)) / oa; dst[i + 2] = (B * sa + dst[i + 2] * da * (1 - sa)) / oa;
          dst[i + 3] = oa * 255;
        }
      }
      p.putImageData(im, bx, by);
      return;
    }
    if (s.brush === 'wc') {
      // 얼룩진 본체 + 가장자리 물자국
      const body = document.createElement('canvas'); body.width = bw; body.height = bh;
      const b = body.getContext('2d');
      b.drawImage(this.live, bx, by, bw, bh, 0, 0, bw, bh);
      const pat = blotPattern(b, this.k);
      pat.setTransform(new DOMMatrix().translate(-bx, -by).scale(this.k * 1.6));
      b.globalCompositeOperation = 'destination-in'; b.fillStyle = pat; b.fillRect(0, 0, bw, bh);
      pat.setTransform(new DOMMatrix().scale(this.k * 1.6));
      p.save(); p.globalCompositeOperation = comp; p.globalAlpha = cfg.alpha * s.op; p.drawImage(body, bx, by); p.restore();
      body.width = body.height = 0;
      if (canFilter) {
        const rim = document.createElement('canvas'); rim.width = bw; rim.height = bh;
        const rc = rim.getContext('2d');
        rc.drawImage(this.live, bx, by, bw, bh, 0, 0, bw, bh);
        rc.globalCompositeOperation = 'destination-out';
        rc.filter = `blur(${Math.max(2, s.D * .07)}px)`;
        rc.drawImage(this.live, bx, by, bw, bh, 0, 0, bw, bh);
        p.save(); p.globalCompositeOperation = comp; p.globalAlpha = .55 * s.op; p.drawImage(rim, bx, by); p.restore();
        rim.width = rim.height = 0;
      }
    } else {
      p.save(); p.globalCompositeOperation = comp; p.globalAlpha = cfg.alpha * s.op;
      p.drawImage(this.live, bx, by, bw, bh, bx, by, bw, bh); p.restore();
    }
  }

  /* ---------- 되돌리기 ---------- */
  push(e) {
    this.undoStack.push(e); this.bytes += e.bw * e.bh * 8;
    this.redoStack = [];
    while (this.undoStack.length > MAX_UNDO || (this.bytes > MAX_UNDO_BYTES && this.undoStack.length > 1)) {
      const o = this.undoStack.shift(); this.bytes -= o.bw * o.bh * 8;
    }
    this.onHistory();
  }
  undo() {
    const e = this.undoStack.pop(); if (!e) return null;
    this.pc.putImageData(e.before, e.bx, e.by); this.redoStack.push(e); this.onHistory();
    return { x: e.bx / this.k, y: e.by / this.k, w: e.bw / this.k, h: e.bh / this.k };
  }
  redo() {
    const e = this.redoStack.pop(); if (!e) return null;
    this.pc.putImageData(e.after, e.bx, e.by); this.undoStack.push(e); this.onHistory();
    return { x: e.bx / this.k, y: e.by / this.k, w: e.bw / this.k, h: e.bh / this.k };
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
