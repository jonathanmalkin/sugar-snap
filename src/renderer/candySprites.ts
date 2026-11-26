/**
 * Sugar Snap — procedural candy sprite atlas.
 *
 * Every candy, special, ingredient, blocker and badge is painted once into an
 * offscreen canvas sized to Math.ceil(cellSize * dpr) device pixels, then
 * blitted every frame. Re-bakes automatically when the cell size or the
 * device pixel ratio changes.
 */
import type { Candy, CandyColor, IngredientType } from '../engine/types';

type Ctx = CanvasRenderingContext2D;
type Pt = readonly [number, number];

export interface CandyPalette {
  light: string;
  base: string;
  mid: string;
  dark: string;
  deep: string;
  glow: string;
  rim: string;
  particle: string;
}

export const CANDY_PALETTES: Record<CandyColor, CandyPalette> = {
  red: {
    light: '#ffc2cc',
    base: '#ff4462',
    mid: '#e41d47',
    dark: '#a3072f',
    deep: '#560015',
    glow: '#ff9a84',
    rim: '#ffc9b0',
    particle: '#ff4766',
  },
  orange: {
    light: '#ffe6b5',
    base: '#ffa02a',
    mid: '#f77d00',
    dark: '#b84f00',
    deep: '#5e2600',
    glow: '#ffd88a',
    rim: '#fff1bd',
    particle: '#ff9d2e',
  },
  yellow: {
    light: '#fffbd6',
    base: '#ffe03d',
    mid: '#f8c400',
    dark: '#c28800',
    deep: '#6e4900',
    glow: '#fff5a8',
    rim: '#fffbe3',
    particle: '#ffd93b',
  },
  green: {
    light: '#d4ffdb',
    base: '#47da72',
    mid: '#1fb550',
    dark: '#0a7a33',
    deep: '#023d17',
    glow: '#b0ffc0',
    rim: '#e3ffd6',
    particle: '#41d870',
  },
  blue: {
    light: '#d2ecff',
    base: '#44a3ff',
    mid: '#1c76f2',
    dark: '#0b45b0',
    deep: '#041c57',
    glow: '#a8d9ff',
    rim: '#dcf2ff',
    particle: '#4aa3ff',
  },
  purple: {
    light: '#f0d4ff',
    base: '#b963ff',
    mid: '#9636ee',
    dark: '#5d13a6',
    deep: '#2a0352',
    glow: '#e6b3ff',
    rim: '#f6e0ff',
    particle: '#b866ff',
  },
};

const CHERRY_PAL: CandyPalette = {
  light: '#ffb0bb',
  base: '#e8173f',
  mid: '#bd0a30',
  dark: '#780420',
  deep: '#36000e',
  glow: '#ff6f6f',
  rim: '#ffb8a6',
  particle: '#e8173f',
};

const HAZEL_PAL: CandyPalette = {
  light: '#f1c08c',
  base: '#bf7236',
  mid: '#985322',
  dark: '#5f300f',
  deep: '#2b1204',
  glow: '#f2a65c',
  rim: '#ffd5a1',
  particle: '#c47a3c',
};

const ICING_PAL: CandyPalette = {
  light: '#ffffff',
  base: '#fffaf6',
  mid: '#f5ebe8',
  dark: '#d9cbd3',
  deep: '#a99bb8',
  glow: '#ffffff',
  rim: '#ffffff',
  particle: '#ffffff',
};

const NEUTRAL_PAL: CandyPalette = {
  light: '#ffffff',
  base: '#f2e6ff',
  mid: '#d6c4ea',
  dark: '#9a86b5',
  deep: '#4d3d66',
  glow: '#ffffff',
  rim: '#ffffff',
  particle: '#ffe9a8',
};

export const GOLD = '#ffd45c';
export const SPRINKLE_COLORS = ['#ff4d6d', '#ffa336', '#ffe066', '#5ee38a', '#4dabff', '#c77dff', '#ffffff', '#ff8fd0'];

export function candyColorHex(color: CandyColor | 'none'): string {
  return color === 'none' ? GOLD : CANDY_PALETTES[color].particle;
}

export function candyDeepHex(color: CandyColor | 'none'): string {
  return color === 'none' ? '#6b3a00' : CANDY_PALETTES[color].deep;
}

export function withAlpha(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w: number, h: number = w): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return [c, ctx];
}

/** Rounded rectangle without relying on CanvasRenderingContext2D.roundRect. */
export function roundRectPath(p: Path2D | Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  p.moveTo(x + rr, y);
  p.lineTo(x + w - rr, y);
  p.arcTo(x + w, y, x + w, y + rr, rr);
  p.lineTo(x + w, y + h - rr);
  p.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  p.lineTo(x + rr, y + h);
  p.arcTo(x, y + h, x, y + h - rr, rr);
  p.lineTo(x, y + rr);
  p.arcTo(x, y, x + rr, y, rr);
  p.closePath();
}

function roundedPolygon(pts: Pt[], radii: number[]): Path2D {
  const p = new Path2D();
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  p.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const m = mid(cur, next);
    p.arcTo(cur[0], cur[1], m[0], m[1], radii[i % radii.length]);
  }
  p.closePath();
  return p;
}

function polarPath(cx: number, cy: number, steps: number, radius: (theta: number) => number): Path2D {
  const p = new Path2D();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = radius(t);
    const x = cx + Math.cos(t) * r;
    const y = cy + Math.sin(t) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function circlePath(cx: number, cy: number, r: number): Path2D {
  const p = new Path2D();
  p.arc(cx, cy, r, 0, Math.PI * 2);
  return p;
}

/* -------------------------------------------------------------------------- */
/* Shading primitives                                                          */
/* -------------------------------------------------------------------------- */

interface BodyGeom {
  cx: number;
  cy: number;
  r: number;
}

/** Ambient shadow, rich radial body, subsurface glow, edge depth and bottom rim bounce. */
function bodyBase(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette, g: BodyGeom, shadow = true): void {
  if (shadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(45, 12, 35, 0.42)';
    ctx.shadowBlur = S * 0.07;
    ctx.shadowOffsetY = S * 0.04;
    ctx.fillStyle = pal.dark;
    ctx.fill(path);
    ctx.restore();
  }

  const grad = ctx.createRadialGradient(g.cx - g.r * 0.34, g.cy - g.r * 0.42, g.r * 0.04, g.cx, g.cy + g.r * 0.05, g.r * 1.12);
  grad.addColorStop(0, pal.light);
  grad.addColorStop(0.2, pal.base);
  grad.addColorStop(0.58, pal.mid);
  grad.addColorStop(0.86, pal.dark);
  grad.addColorStop(1, pal.deep);
  ctx.fillStyle = grad;
  ctx.fill(path);

  ctx.save();
  ctx.clip(path);

  // Subsurface scattering: warm glow pooling in the lower body.
  const sg = ctx.createRadialGradient(g.cx + g.r * 0.08, g.cy + g.r * 0.38, 0, g.cx + g.r * 0.08, g.cy + g.r * 0.38, g.r * 0.85);
  sg.addColorStop(0, withAlpha(pal.glow, 0.6));
  sg.addColorStop(0.5, withAlpha(pal.glow, 0.22));
  sg.addColorStop(1, withAlpha(pal.glow, 0));
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  // Edge depth: deep inner stroke all around.
  ctx.lineWidth = S * 0.05;
  ctx.strokeStyle = withAlpha(pal.deep, 0.32);
  ctx.stroke(path);

  // Bottom rim bounce light.
  const rg = ctx.createLinearGradient(0, g.cy - g.r * 0.1, 0, g.cy + g.r * 1.05);
  rg.addColorStop(0, withAlpha(pal.rim, 0));
  rg.addColorStop(0.7, withAlpha(pal.rim, 0.25));
  rg.addColorStop(1, withAlpha(pal.rim, 0.85));
  ctx.lineWidth = S * 0.034;
  ctx.strokeStyle = rg;
  ctx.stroke(path);

  ctx.restore();
}

/** Curved glass specular crescent plus a crisp pin-point glint. */
function specular(ctx: Ctx, S: number, path: Path2D | null, g: BodyGeom, opts?: { a0?: number; a1?: number; thick?: number; alpha?: number; dot?: boolean }): void {
  const a0 = opts?.a0 ?? Math.PI * 1.02;
  const a1 = opts?.a1 ?? Math.PI * 1.48;
  const thick = (opts?.thick ?? 0.24) * g.r;
  const alpha = opts?.alpha ?? 0.92;
  const r = g.r * 0.8;
  const mid = (a0 + a1) / 2;
  const dx = Math.cos(mid);
  const dy = Math.sin(mid);

  ctx.save();
  if (path) ctx.clip(path);
  const p = new Path2D();
  p.arc(g.cx, g.cy, r, a0, a1);
  p.arc(g.cx - dx * thick, g.cy - dy * thick, r, a1, a0, true);
  p.closePath();
  const gr = ctx.createLinearGradient(g.cx + dx * r, g.cy + dy * r, g.cx + dx * (r - thick * 1.4), g.cy + dy * (r - thick * 1.4));
  gr.addColorStop(0, `rgba(255,255,255,${alpha})`);
  gr.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.45})`);
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fill(p);

  if (opts?.dot !== false) {
    const gx = g.cx + Math.cos(mid + 0.12) * r * 0.62;
    const gy = g.cy + Math.sin(mid + 0.12) * r * 0.62;
    const dg = ctx.createRadialGradient(gx, gy, 0, gx, gy, S * 0.045);
    dg.addColorStop(0, 'rgba(255,255,255,1)');
    dg.addColorStop(0.45, 'rgba(255,255,255,0.75)');
    dg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.arc(gx, gy, S * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function fourPointStar(ctx: Ctx, x: number, y: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Candy silhouettes                                                           */
/* -------------------------------------------------------------------------- */

interface Shape {
  path: Path2D;
  geom: BodyGeom;
  spec: { a0?: number; a1?: number; thick?: number; alpha?: number };
}

function rotator(cx: number, cy: number, a: number, S: number) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return (x: number, y: number): Pt => [(cx + (x - cx) * c - (y - cy) * s) * S, (cy + (x - cx) * s + (y - cy) * c) * S];
}

function beanShape(S: number): Shape {
  const P = rotator(0.5, 0.52, -0.34, S);
  const p = new Path2D();
  const m = P(0.1, 0.53);
  p.moveTo(m[0], m[1]);
  const seg = (a: Pt, b: Pt, c: Pt) => p.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
  seg(P(0.08, 0.27), P(0.32, 0.17), P(0.5, 0.31));
  seg(P(0.68, 0.17), P(0.92, 0.27), P(0.9, 0.53));
  seg(P(0.88, 0.77), P(0.68, 0.85), P(0.5, 0.85));
  seg(P(0.32, 0.85), P(0.12, 0.77), P(0.1, 0.53));
  p.closePath();
  return { path: p, geom: { cx: S * 0.5, cy: S * 0.53, r: S * 0.38 }, spec: { a0: Math.PI * 1.0, a1: Math.PI * 1.42, thick: 0.22 } };
}

function lozengePoints(S: number, k = 1): Pt[] {
  const cx = 0.5;
  const cy = 0.5;
  const raw: Pt[] = [
    [0.08, 0.5],
    [0.29, 0.2],
    [0.71, 0.2],
    [0.92, 0.5],
    [0.71, 0.8],
    [0.29, 0.8],
  ];
  return raw.map(([x, y]) => [(cx + (x - cx) * k) * S, (cy + (y - cy) * k) * S] as Pt);
}

function lozengeShape(S: number): Shape {
  const path = roundedPolygon(lozengePoints(S), [S * 0.07, S * 0.06, S * 0.06, S * 0.07, S * 0.06, S * 0.06]);
  return { path, geom: { cx: S * 0.5, cy: S * 0.5, r: S * 0.4 }, spec: { a0: Math.PI * 1.08, a1: Math.PI * 1.4, thick: 0.2 } };
}

function starPoints(S: number, cx: number, cy: number, ro: number, ri: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? ro : ri;
    pts.push([(cx + Math.cos(a) * r) * S, (cy + Math.sin(a) * r) * S]);
  }
  return pts;
}

function starShape(S: number): Shape {
  const path = roundedPolygon(starPoints(S, 0.5, 0.54, 0.45, 0.25), [S * 0.085, S * 0.07]);
  return { path, geom: { cx: S * 0.5, cy: S * 0.53, r: S * 0.37 }, spec: { a0: Math.PI * 1.05, a1: Math.PI * 1.42, thick: 0.22 } };
}

function squareShape(S: number): Shape {
  const p = new Path2D();
  roundRectPath(p, S * 0.14, S * 0.14, S * 0.72, S * 0.72, S * 0.17);
  return { path: p, geom: { cx: S * 0.5, cy: S * 0.5, r: S * 0.38 }, spec: { a0: Math.PI * 1.06, a1: Math.PI * 1.44, thick: 0.2 } };
}

function sphereShape(S: number): Shape {
  return {
    path: circlePath(S * 0.5, S * 0.47, S * 0.35),
    geom: { cx: S * 0.5, cy: S * 0.47, r: S * 0.35 },
    spec: { a0: Math.PI * 1.0, a1: Math.PI * 1.5, thick: 0.26 },
  };
}

function bonbonShape(S: number): Shape {
  const path = polarPath(S * 0.5, S * 0.51, 180, (t) => S * (0.37 + 0.022 * Math.cos(t * 12)));
  return { path, geom: { cx: S * 0.5, cy: S * 0.51, r: S * 0.38 }, spec: { a0: Math.PI * 1.02, a1: Math.PI * 1.46, thick: 0.22 } };
}

function shapeFor(color: CandyColor, S: number): Shape {
  switch (color) {
    case 'red':
      return beanShape(S);
    case 'orange':
      return lozengeShape(S);
    case 'yellow':
      return starShape(S);
    case 'green':
      return squareShape(S);
    case 'blue':
      return sphereShape(S);
    case 'purple':
      return bonbonShape(S);
  }
}

/* -------------------------------------------------------------------------- */
/* Per-candy details                                                           */
/* -------------------------------------------------------------------------- */

function lozengeFacets(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette): void {
  const outer = lozengePoints(S);
  const inner = lozengePoints(S, 0.52);
  const lx = -0.6;
  const ly = -0.8;
  ctx.save();
  ctx.clip(path);
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const mx = (outer[i][0] + outer[j][0]) / 2 - S * 0.5;
    const my = (outer[i][1] + outer[j][1]) / 2 - S * 0.5;
    const len = Math.hypot(mx, my) || 1;
    const d = (mx / len) * lx + (my / len) * ly;
    ctx.beginPath();
    ctx.moveTo(outer[i][0], outer[i][1]);
    ctx.lineTo(outer[j][0], outer[j][1]);
    ctx.lineTo(inner[j][0], inner[j][1]);
    ctx.lineTo(inner[i][0], inner[i][1]);
    ctx.closePath();
    ctx.fillStyle = d > 0 ? `rgba(255,255,255,${0.3 * d})` : withAlpha(pal.deep, 0.28 * -d);
    ctx.fill();
  }
  // Table facet with citrus segments.
  ctx.beginPath();
  inner.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  const tg = ctx.createLinearGradient(0, S * 0.32, 0, S * 0.68);
  tg.addColorStop(0, 'rgba(255,255,255,0.28)');
  tg.addColorStop(1, 'rgba(255,255,255,0.02)');
  ctx.fillStyle = tg;
  ctx.fill();
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = 'rgba(255,248,220,0.55)';
  ctx.stroke();
  ctx.strokeStyle = withAlpha(pal.light, 0.4);
  ctx.lineWidth = S * 0.008;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(S * 0.5, S * 0.5);
    ctx.lineTo(S * 0.5 + Math.cos(a) * S * 0.11, S * 0.5 + Math.sin(a) * S * 0.085);
    ctx.stroke();
  }
  // Crisp facet edges.
  ctx.strokeStyle = 'rgba(255,240,210,0.35)';
  ctx.lineWidth = S * 0.01;
  for (let i = 0; i < outer.length; i++) {
    ctx.beginPath();
    ctx.moveTo(outer[i][0], outer[i][1]);
    ctx.lineTo(inner[i][0], inner[i][1]);
    ctx.stroke();
  }
  ctx.restore();
}

function starDetails(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette): void {
  ctx.save();
  ctx.clip(path);
  const dome = ctx.createRadialGradient(S * 0.47, S * 0.46, 0, S * 0.5, S * 0.52, S * 0.3);
  dome.addColorStop(0, 'rgba(255,255,240,0.5)');
  dome.addColorStop(1, 'rgba(255,255,240,0)');
  ctx.fillStyle = dome;
  ctx.fillRect(0, 0, S, S);
  // Inner pillow ridge.
  const inner = roundedPolygon(starPoints(S, 0.5, 0.54, 0.31, 0.175), [S * 0.06, S * 0.05]);
  ctx.lineWidth = S * 0.018;
  ctx.strokeStyle = withAlpha(pal.dark, 0.22);
  ctx.stroke(inner);
  // Sugar crystals.
  const rnd = mulberry32(77);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * S * 0.36;
    const x = S * 0.5 + Math.cos(a) * d;
    const y = S * 0.54 + Math.sin(a) * d;
    ctx.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.4})`;
    ctx.fillRect(x, y, S * 0.012, S * 0.012);
  }
  ctx.restore();
}

function squareBevel(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette): void {
  ctx.save();
  ctx.clip(path);
  const face = new Path2D();
  roundRectPath(face, S * 0.225, S * 0.215, S * 0.55, S * 0.55, S * 0.1);
  const fg = ctx.createLinearGradient(0, S * 0.22, 0, S * 0.77);
  fg.addColorStop(0, withAlpha(pal.light, 0.42));
  fg.addColorStop(0.5, withAlpha(pal.base, 0.12));
  fg.addColorStop(1, withAlpha(pal.dark, 0.18));
  ctx.fillStyle = fg;
  ctx.fill(face);
  // Bevel edge: highlight on top-left, shadow bottom-right.
  ctx.save();
  ctx.clip(face);
  ctx.lineWidth = S * 0.035;
  ctx.strokeStyle = withAlpha(pal.deep, 0.3);
  ctx.translate(-S * 0.008, -S * 0.012);
  ctx.stroke(face);
  ctx.restore();
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = withAlpha(pal.rim, 0.55);
  ctx.stroke(face);
  // Mint micro-stripes.
  ctx.save();
  ctx.clip(face);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = S * 0.03;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(S * (0.2 + i * 0.12), S * 0.8);
    ctx.lineTo(S * (0.6 + i * 0.12), S * 0.2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

function lollipopStick(ctx: Ctx, S: number): void {
  ctx.save();
  ctx.shadowColor = 'rgba(40,20,40,0.35)';
  ctx.shadowBlur = S * 0.03;
  ctx.shadowOffsetY = S * 0.015;
  const p = new Path2D();
  roundRectPath(p, S * 0.468, S * 0.7, S * 0.064, S * 0.25, S * 0.03);
  const g = ctx.createLinearGradient(S * 0.468, 0, S * 0.532, 0);
  g.addColorStop(0, '#e7dccc');
  g.addColorStop(0.4, '#ffffff');
  g.addColorStop(1, '#cbbba5');
  ctx.fillStyle = g;
  ctx.fill(p);
  ctx.restore();
}

function lollipopSwirl(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette, g: BodyGeom): void {
  ctx.save();
  ctx.clip(path);
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 2; arm++) {
    ctx.beginPath();
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = arm * Math.PI + t * Math.PI * 2.7;
      const r = g.r * (0.04 + t * 1.0);
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = S * 0.06;
    ctx.strokeStyle = 'rgba(255,248,236,0.92)';
    ctx.stroke();
    ctx.lineWidth = S * 0.018;
    ctx.strokeStyle = withAlpha(pal.light, 0.6);
    ctx.stroke();
  }
  // Curve the swirl into the sphere.
  const sh = ctx.createRadialGradient(g.cx - g.r * 0.2, g.cy - g.r * 0.25, g.r * 0.2, g.cx, g.cy, g.r * 1.02);
  sh.addColorStop(0, withAlpha(pal.deep, 0));
  sh.addColorStop(0.7, withAlpha(pal.deep, 0.18));
  sh.addColorStop(1, withAlpha(pal.deep, 0.55));
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = S * 0.03;
  const rg = ctx.createLinearGradient(0, g.cy, 0, g.cy + g.r);
  rg.addColorStop(0, withAlpha(pal.rim, 0));
  rg.addColorStop(1, withAlpha(pal.rim, 0.8));
  ctx.strokeStyle = rg;
  ctx.stroke(path);
  ctx.restore();
}

function bonbonFlutes(ctx: Ctx, S: number, path: Path2D, pal: CandyPalette, g: BodyGeom): void {
  ctx.save();
  ctx.clip(path);
  ctx.lineCap = 'round';
  for (let k = 0; k < 12; k++) {
    const valley = ((k + 0.5) / 12) * Math.PI * 2;
    const peak = (k / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(g.cx + Math.cos(valley) * g.r * 0.32, g.cy + Math.sin(valley) * g.r * 0.32);
    ctx.lineTo(g.cx + Math.cos(valley) * g.r * 1.02, g.cy + Math.sin(valley) * g.r * 1.02);
    ctx.lineWidth = S * 0.022;
    ctx.strokeStyle = withAlpha(pal.deep, 0.24);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.cx + Math.cos(peak) * g.r * 0.36, g.cy + Math.sin(peak) * g.r * 0.36);
    ctx.lineTo(g.cx + Math.cos(peak) * g.r * 0.96, g.cy + Math.sin(peak) * g.r * 0.96);
    ctx.lineWidth = S * 0.016;
    ctx.strokeStyle = withAlpha(pal.light, 0.26);
    ctx.stroke();
  }
  ctx.restore();
  // Glossy kiss-dome on top.
  const dome = circlePath(g.cx, g.cy - g.r * 0.04, g.r * 0.33);
  bodyBase(ctx, S, dome, pal, { cx: g.cx, cy: g.cy - g.r * 0.04, r: g.r * 0.33 }, false);
  ctx.save();
  ctx.shadowColor = withAlpha(pal.deep, 0.5);
  ctx.shadowBlur = S * 0.02;
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = withAlpha(pal.light, 0.5);
  ctx.stroke(dome);
  ctx.restore();
  // Little swirl tip.
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = S * 0.02;
  ctx.strokeStyle = withAlpha(pal.light, 0.7);
  ctx.beginPath();
  ctx.arc(g.cx, g.cy - g.r * 0.06, g.r * 0.15, Math.PI * 0.9, Math.PI * 2.1);
  ctx.stroke();
  ctx.restore();
}

function drawRegular(ctx: Ctx, S: number, color: CandyColor): Shape {
  const pal = CANDY_PALETTES[color];
  const shape = shapeFor(color, S);
  if (color === 'blue') lollipopStick(ctx, S);
  bodyBase(ctx, S, shape.path, pal, shape.geom);
  switch (color) {
    case 'orange':
      lozengeFacets(ctx, S, shape.path, pal);
      break;
    case 'yellow':
      starDetails(ctx, S, shape.path, pal);
      break;
    case 'green':
      squareBevel(ctx, S, shape.path, pal);
      break;
    case 'blue':
      lollipopSwirl(ctx, S, shape.path, pal, shape.geom);
      break;
    case 'purple':
      bonbonFlutes(ctx, S, shape.path, pal, shape.geom);
      break;
    case 'red': {
      // Jelly bean seam & inner translucency.
      ctx.save();
      ctx.clip(shape.path);
      const ig = ctx.createRadialGradient(S * 0.55, S * 0.6, 0, S * 0.55, S * 0.6, S * 0.22);
      ig.addColorStop(0, withAlpha(pal.glow, 0.35));
      ig.addColorStop(1, withAlpha(pal.glow, 0));
      ctx.fillStyle = ig;
      ctx.fillRect(0, 0, S, S);
      ctx.restore();
      break;
    }
  }
  specular(ctx, S, shape.path, shape.geom, shape.spec);
  return shape;
}

/* -------------------------------------------------------------------------- */
/* Specials                                                                    */
/* -------------------------------------------------------------------------- */

function drawStriped(ctx: Ctx, S: number, color: CandyColor, orient: 'h' | 'v'): void {
  const pal = CANDY_PALETTES[color];
  const shape = shapeFor(color, S);
  if (color === 'blue') lollipopStick(ctx, S);
  bodyBase(ctx, S, shape.path, pal, shape.geom);
  ctx.save();
  ctx.clip(shape.path);
  ctx.lineCap = 'butt';
  const step = S * 0.15;
  for (let i = -4; i <= 4; i++) {
    const off = i * step;
    const white = i % 2 === 0;
    ctx.beginPath();
    if (orient === 'h') {
      const y = shape.geom.cy + off;
      ctx.moveTo(0, y - S * 0.03);
      ctx.quadraticCurveTo(S * 0.5, y + S * 0.06, S, y - S * 0.03);
    } else {
      const x = shape.geom.cx + off;
      ctx.moveTo(x - S * 0.03, 0);
      ctx.quadraticCurveTo(x + S * 0.06, S * 0.5, x - S * 0.03, S);
    }
    ctx.lineWidth = white ? S * 0.075 : S * 0.05;
    ctx.strokeStyle = white ? 'rgba(255,255,255,0.93)' : withAlpha(pal.dark, 0.55);
    ctx.stroke();
    if (white) {
      ctx.lineWidth = S * 0.018;
      ctx.strokeStyle = withAlpha(pal.light, 0.7);
      ctx.stroke();
    }
  }
  // Re-curve the stripes into the body.
  const g = shape.geom;
  const sh = ctx.createRadialGradient(g.cx - g.r * 0.3, g.cy - g.r * 0.35, g.r * 0.15, g.cx, g.cy, g.r * 1.1);
  sh.addColorStop(0, 'rgba(255,255,255,0.12)');
  sh.addColorStop(0.65, withAlpha(pal.deep, 0.1));
  sh.addColorStop(1, withAlpha(pal.deep, 0.5));
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = S * 0.03;
  ctx.strokeStyle = withAlpha(pal.rim, 0.45);
  ctx.stroke(shape.path);
  ctx.restore();
  specular(ctx, S, shape.path, shape.geom, { ...shape.spec, alpha: 0.95 });
}

function drawWrapped(ctx: Ctx, S: number, color: CandyColor): void {
  const pal = CANDY_PALETTES[color];
  // Warm inner aura.
  const aura = ctx.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.5);
  aura.addColorStop(0, withAlpha(pal.glow, 0.7));
  aura.addColorStop(0.6, withAlpha(pal.glow, 0.25));
  aura.addColorStop(1, withAlpha(pal.glow, 0));
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, S, S);

  const x0 = S * 0.15;
  const w = S * 0.7;
  const wrap = new Path2D();
  roundRectPath(wrap, x0, x0, w, w, S * 0.13);

  // Pinched twisted corners (ears).
  const ears = new Path2D();
  const ear = (cx: number, cy: number, sx: number, sy: number) => {
    ears.moveTo(cx + sx * S * 0.09, cy);
    ears.quadraticCurveTo(cx + sx * S * 0.02, cy - sy * S * 0.06, cx - sx * S * 0.07, cy - sy * S * 0.11);
    ears.quadraticCurveTo(cx - sx * S * 0.04, cy - sy * S * 0.04, cx - sx * S * 0.11, cy - sy * S * 0.07);
    ears.quadraticCurveTo(cx - sx * S * 0.06, cy + sy * S * 0.02, cx, cy + sy * S * 0.09);
    ears.closePath();
  };
  ear(x0 + S * 0.03, x0 + S * 0.03, 1, 1);
  ear(x0 + w - S * 0.03, x0 + S * 0.03, -1, 1);
  ear(x0 + S * 0.03, x0 + w - S * 0.03, 1, -1);
  ear(x0 + w - S * 0.03, x0 + w - S * 0.03, -1, -1);

  ctx.save();
  ctx.shadowColor = 'rgba(45,12,35,0.35)';
  ctx.shadowBlur = S * 0.06;
  ctx.shadowOffsetY = S * 0.035;
  ctx.fillStyle = withAlpha(pal.mid, 0.55);
  ctx.fill(ears);
  ctx.fillStyle = withAlpha(pal.base, 0.35);
  ctx.fill(wrap);
  ctx.restore();
  const eg = ctx.createLinearGradient(0, 0, S, S);
  eg.addColorStop(0, withAlpha(pal.light, 0.9));
  eg.addColorStop(0.5, withAlpha(pal.base, 0.6));
  eg.addColorStop(1, withAlpha(pal.dark, 0.8));
  ctx.fillStyle = eg;
  ctx.fill(ears);
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.stroke(ears);

  // Candy nestled inside.
  ctx.save();
  ctx.translate(S * 0.5, S * 0.5);
  ctx.scale(0.72, 0.72);
  ctx.translate(-S * 0.5, -S * 0.5);
  drawRegular(ctx, S, color);
  ctx.restore();

  // Cellophane front: tint, crinkles, gloss.
  ctx.save();
  ctx.clip(wrap);
  const front = ctx.createLinearGradient(0, x0, 0, x0 + w);
  front.addColorStop(0, 'rgba(255,255,255,0.32)');
  front.addColorStop(0.45, withAlpha(pal.light, 0.12));
  front.addColorStop(1, withAlpha(pal.base, 0.22));
  ctx.fillStyle = front;
  ctx.fill(wrap);
  const rnd = mulberry32(color.length * 131 + 7);
  ctx.lineJoin = 'round';
  for (let i = 0; i < 11; i++) {
    let x = x0 + rnd() * w;
    let y = x0 + rnd() * w;
    let a = rnd() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      a += (rnd() - 0.5) * 1.6;
      const len = S * (0.04 + rnd() * 0.07);
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      ctx.lineTo(x, y);
    }
    ctx.lineWidth = S * (0.008 + rnd() * 0.008);
    ctx.strokeStyle = i % 3 === 0 ? withAlpha(pal.deep, 0.18) : 'rgba(255,255,255,0.5)';
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineWidth = S * 0.022;
  ctx.strokeStyle = 'rgba(255,255,255,0.78)';
  ctx.stroke(wrap);
  ctx.lineWidth = S * 0.01;
  ctx.strokeStyle = withAlpha(pal.dark, 0.45);
  ctx.save();
  ctx.translate(0, S * 0.012);
  ctx.stroke(wrap);
  ctx.restore();
  // Big glossy wrapper sheen.
  ctx.save();
  ctx.clip(wrap);
  const sheen = new Path2D();
  sheen.moveTo(x0, x0 + w * 0.42);
  sheen.quadraticCurveTo(x0 + w * 0.15, x0 + w * 0.05, x0 + w * 0.62, x0);
  sheen.lineTo(x0 + w * 0.42, x0);
  sheen.quadraticCurveTo(x0 + w * 0.1, x0 + w * 0.06, x0, x0 + w * 0.28);
  sheen.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.0)';
  const sg = ctx.createLinearGradient(x0, x0, x0 + w * 0.5, x0 + w * 0.5);
  sg.addColorStop(0, 'rgba(255,255,255,0.85)');
  sg.addColorStop(1, 'rgba(255,255,255,0.1)');
  ctx.fillStyle = sg;
  ctx.fill(sheen);
  ctx.restore();
  fourPointStar(ctx, x0 + w * 0.86, x0 + w * 0.16, S * 0.05, 'rgba(255,255,255,0.95)');
}

function drawColorBomb(ctx: Ctx, S: number): void {
  const choc: CandyPalette = {
    light: '#b37a52',
    base: '#6e3d22',
    mid: '#4a2513',
    dark: '#2b1308',
    deep: '#120602',
    glow: '#a0582c',
    rim: '#e09a62',
    particle: '#6e3d22',
  };
  const g: BodyGeom = { cx: S * 0.5, cy: S * 0.5, r: S * 0.385 };
  const path = circlePath(g.cx, g.cy, g.r);
  // Rainbow halo behind the truffle.
  const halo = ctx.createRadialGradient(g.cx, g.cy, g.r * 0.8, g.cx, g.cy, S * 0.5);
  halo.addColorStop(0, 'rgba(255,220,120,0.45)');
  halo.addColorStop(1, 'rgba(255,120,200,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);
  bodyBase(ctx, S, path, choc, g);
  // Sprinkles with 3D shading, foreshortened toward the rim.
  ctx.save();
  ctx.clip(path);
  const rnd = mulberry32(4242);
  ctx.lineCap = 'round';
  const placed: Pt[] = [];
  let tries = 0;
  while (placed.length < 22 && tries < 400) {
    tries++;
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * g.r * 0.9;
    const x = g.cx + Math.cos(a) * d;
    const y = g.cy + Math.sin(a) * d;
    if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < S * 0.075)) continue;
    placed.push([x, y]);
    const fore = 1 - Math.pow(d / g.r, 2) * 0.55;
    const ang = rnd() * Math.PI;
    const len = S * 0.075 * fore;
    const col = SPRINKLE_COLORS[placed.length % SPRINKLE_COLORS.length];
    const dx = (Math.cos(ang) * len) / 2;
    const dy = (Math.sin(ang) * len) / 2;
    ctx.lineWidth = S * 0.036 * (0.75 + fore * 0.25);
    ctx.strokeStyle = 'rgba(10,3,0,0.5)';
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy + S * 0.008);
    ctx.lineTo(x + dx, y + dy + S * 0.008);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
    ctx.lineWidth = S * 0.011;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(x - dx * 0.7, y - dy * 0.7 - S * 0.007);
    ctx.lineTo(x + dx * 0.4, y + dy * 0.4 - S * 0.007);
    ctx.stroke();
  }
  // Chocolate depth over the sprinkles near the rim.
  const sh = ctx.createRadialGradient(g.cx - g.r * 0.25, g.cy - g.r * 0.3, g.r * 0.3, g.cx, g.cy, g.r * 1.02);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(0.75, 'rgba(18,6,2,0.15)');
  sh.addColorStop(1, 'rgba(18,6,2,0.6)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = S * 0.03;
  const rg = ctx.createLinearGradient(0, g.cy, 0, g.cy + g.r);
  rg.addColorStop(0, 'rgba(224,154,98,0)');
  rg.addColorStop(1, 'rgba(240,170,110,0.75)');
  ctx.strokeStyle = rg;
  ctx.stroke(path);
  ctx.restore();
  specular(ctx, S, path, g, { a0: Math.PI * 1.0, a1: Math.PI * 1.5, thick: 0.26, alpha: 0.75 });
}

/* -------------------------------------------------------------------------- */
/* Ingredients                                                                 */
/* -------------------------------------------------------------------------- */

function drawCherry(ctx: Ctx, S: number): void {
  // Stems.
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(30,20,10,0.3)';
  ctx.shadowBlur = S * 0.02;
  ctx.shadowOffsetY = S * 0.01;
  const stem = (x0: number, y0: number, cx: number, cy: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, S * 0.56, S * 0.13);
    ctx.lineWidth = S * 0.035;
    ctx.strokeStyle = '#5b7a1e';
    ctx.stroke();
    ctx.lineWidth = S * 0.012;
    ctx.strokeStyle = 'rgba(220,255,160,0.6)';
    ctx.stroke();
  };
  stem(S * 0.33, S * 0.47, S * 0.36, S * 0.22);
  stem(S * 0.66, S * 0.45, S * 0.64, S * 0.26);
  ctx.restore();
  // Leaf.
  ctx.save();
  ctx.translate(S * 0.6, S * 0.14);
  ctx.rotate(-0.35);
  const leaf = new Path2D();
  leaf.moveTo(0, 0);
  leaf.quadraticCurveTo(S * 0.1, -S * 0.11, S * 0.25, -S * 0.02);
  leaf.quadraticCurveTo(S * 0.1, S * 0.07, 0, 0);
  const lg = ctx.createLinearGradient(0, -S * 0.1, 0, S * 0.06);
  lg.addColorStop(0, '#9be35a');
  lg.addColorStop(0.6, '#3fa52b');
  lg.addColorStop(1, '#1f6a18');
  ctx.shadowColor = 'rgba(20,40,10,0.35)';
  ctx.shadowBlur = S * 0.02;
  ctx.fillStyle = lg;
  ctx.fill(leaf);
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = S * 0.01;
  ctx.strokeStyle = 'rgba(230,255,190,0.7)';
  ctx.beginPath();
  ctx.moveTo(S * 0.01, 0);
  ctx.quadraticCurveTo(S * 0.12, -S * 0.03, S * 0.23, -S * 0.02);
  ctx.stroke();
  ctx.restore();
  // Twin glossy cherries.
  const balls: BodyGeom[] = [
    { cx: S * 0.33, cy: S * 0.64, r: S * 0.2 },
    { cx: S * 0.66, cy: S * 0.62, r: S * 0.2 },
  ];
  for (const b of balls) {
    const p = circlePath(b.cx, b.cy, b.r);
    bodyBase(ctx, S, p, CHERRY_PAL, b);
    ctx.save();
    ctx.clip(p);
    ctx.lineWidth = S * 0.012;
    ctx.strokeStyle = withAlpha(CHERRY_PAL.deep, 0.4);
    ctx.beginPath();
    ctx.arc(b.cx, b.cy - b.r * 1.2, b.r * 0.55, Math.PI * 0.3, Math.PI * 0.7);
    ctx.stroke();
    ctx.restore();
    specular(ctx, S, p, b, { a0: Math.PI * 1.02, a1: Math.PI * 1.5, thick: 0.3 });
  }
}

function drawHazelnut(ctx: Ctx, S: number): void {
  // Body: plump teardrop.
  const body = new Path2D();
  body.moveTo(S * 0.5, S * 0.92);
  body.bezierCurveTo(S * 0.3, S * 0.9, S * 0.16, S * 0.72, S * 0.18, S * 0.52);
  body.bezierCurveTo(S * 0.2, S * 0.4, S * 0.34, S * 0.36, S * 0.5, S * 0.36);
  body.bezierCurveTo(S * 0.66, S * 0.36, S * 0.8, S * 0.4, S * 0.82, S * 0.52);
  body.bezierCurveTo(S * 0.84, S * 0.72, S * 0.7, S * 0.9, S * 0.5, S * 0.92);
  body.closePath();
  const bg: BodyGeom = { cx: S * 0.5, cy: S * 0.64, r: S * 0.3 };
  bodyBase(ctx, S, body, HAZEL_PAL, bg);
  ctx.save();
  ctx.clip(body);
  ctx.lineWidth = S * 0.01;
  ctx.strokeStyle = withAlpha(HAZEL_PAL.deep, 0.25);
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(S * (0.5 + i * 0.08), S * 0.45);
    ctx.quadraticCurveTo(S * (0.5 + i * 0.11), S * 0.7, S * 0.5, S * 0.92);
    ctx.stroke();
  }
  ctx.restore();
  specular(ctx, S, body, bg, { a0: Math.PI * 1.05, a1: Math.PI * 1.45, thick: 0.24 });

  // Textured acorn-style cap.
  const cap = new Path2D();
  cap.moveTo(S * 0.15, S * 0.5);
  cap.bezierCurveTo(S * 0.14, S * 0.28, S * 0.3, S * 0.18, S * 0.5, S * 0.18);
  cap.bezierCurveTo(S * 0.7, S * 0.18, S * 0.86, S * 0.28, S * 0.85, S * 0.5);
  for (let i = 0; i <= 8; i++) {
    const x = S * (0.85 - (i / 8) * 0.7);
    const y = S * (0.5 + (i % 2 === 0 ? 0.0 : 0.035));
    cap.lineTo(x, y);
  }
  cap.closePath();
  const capPal: CandyPalette = {
    light: '#f3dcae',
    base: '#d0a76c',
    mid: '#b0854b',
    dark: '#795427',
    deep: '#3e2a10',
    glow: '#f4cf8a',
    rim: '#ffe4b5',
    particle: '#d0a76c',
  };
  bodyBase(ctx, S, cap, capPal, { cx: S * 0.5, cy: S * 0.36, r: S * 0.3 });
  ctx.save();
  ctx.clip(cap);
  ctx.fillStyle = withAlpha(capPal.deep, 0.3);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 9; col++) {
      const x = S * (0.18 + col * 0.08 + (row % 2) * 0.04);
      const y = S * (0.26 + row * 0.065);
      ctx.beginPath();
      ctx.ellipse(x, y, S * 0.025, S * 0.016, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = 'rgba(255,240,210,0.35)';
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 9; col++) {
      const x = S * (0.18 + col * 0.08 + (row % 2) * 0.04);
      const y = S * (0.25 + row * 0.065);
      ctx.fillRect(x - S * 0.012, y - S * 0.012, S * 0.016, S * 0.006);
    }
  }
  ctx.restore();
  specular(ctx, S, cap, { cx: S * 0.5, cy: S * 0.4, r: S * 0.3 }, { a0: Math.PI * 1.1, a1: Math.PI * 1.4, thick: 0.18, alpha: 0.7, dot: false });
  // Stalk.
  ctx.save();
  const stalk = new Path2D();
  roundRectPath(stalk, S * 0.475, S * 0.08, S * 0.05, S * 0.13, S * 0.022);
  ctx.fillStyle = '#6b4220';
  ctx.fill(stalk);
  ctx.fillStyle = 'rgba(255,220,170,0.5)';
  ctx.fillRect(S * 0.484, S * 0.095, S * 0.012, S * 0.09);
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Blockers                                                                    */
/* -------------------------------------------------------------------------- */

function squirclePath(cx: number, cy: number, rx: number, ry: number, wobble: number, lobes: number): Path2D {
  const p = new Path2D();
  const n = 4.2;
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const k = 1 + wobble * Math.sin(t * lobes);
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * rx * k;
    const y = cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * ry * k;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function drawFrosting(ctx: Ctx, S: number, layers: 1 | 2 | 3): void {
  const tiers: Array<{ cx: number; cy: number; rx: number; ry: number }> = [{ cx: 0.5, cy: 0.52, rx: 0.44, ry: 0.42 }];
  if (layers >= 2) tiers.push({ cx: 0.5, cy: 0.45, rx: 0.32, ry: 0.27 });
  if (layers >= 3) tiers.push({ cx: 0.5, cy: 0.37, rx: 0.19, ry: 0.15 });
  tiers.forEach((t, i) => {
    const path = squirclePath(t.cx * S, t.cy * S, t.rx * S, t.ry * S, 0.022, 14 + i * 2);
    const geom: BodyGeom = { cx: t.cx * S, cy: t.cy * S, r: Math.max(t.rx, t.ry) * S };
    bodyBase(ctx, S, path, ICING_PAL, geom, true);
    // Piped ridge.
    ctx.save();
    ctx.clip(path);
    const ridge = squirclePath(t.cx * S, t.cy * S + S * 0.012, t.rx * S * 0.78, t.ry * S * 0.74, 0.03, 12);
    ctx.lineWidth = S * 0.016;
    ctx.strokeStyle = 'rgba(170,150,190,0.28)';
    ctx.stroke(ridge);
    ctx.lineWidth = S * 0.01;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.translate(0, -S * 0.01);
    ctx.stroke(ridge);
    ctx.restore();
    specular(ctx, S, path, geom, { a0: Math.PI * 1.08, a1: Math.PI * 1.42, thick: 0.18, alpha: 0.85, dot: i === tiers.length - 1 });
  });
  // Sugar-crystal sparkles.
  const rnd = mulberry32(layers * 97);
  const sparkles = 3 + layers * 2;
  for (let i = 0; i < sparkles; i++) {
    const x = S * (0.18 + rnd() * 0.64);
    const y = S * (0.2 + rnd() * 0.64);
    fourPointStar(ctx, x, y, S * (0.025 + rnd() * 0.025), `rgba(255,255,255,${0.75 + rnd() * 0.25})`);
    ctx.fillStyle = `rgba(190,220,255,${0.35 + rnd() * 0.3})`;
    ctx.fillRect(S * (0.15 + rnd() * 0.7), S * (0.2 + rnd() * 0.65), S * 0.014, S * 0.014);
  }
  // Cracks on weaker layers.
  if (layers < 3) {
    const crackRnd = mulberry32(layers * 13 + 5);
    const count = layers === 1 ? 3 : 1;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let c = 0; c < count; c++) {
      const side = crackRnd() * Math.PI * 2;
      let x = S * 0.5 + Math.cos(side) * S * 0.4;
      let y = S * 0.52 + Math.sin(side) * S * 0.38;
      let a = side + Math.PI + (crackRnd() - 0.5) * 0.6;
      const pts: Pt[] = [[x, y]];
      for (let k = 0; k < 4; k++) {
        a += (crackRnd() - 0.5) * 1.1;
        const len = S * (0.05 + crackRnd() * 0.05);
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        pts.push([x, y]);
      }
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.lineWidth = S * 0.016;
      ctx.strokeStyle = 'rgba(130,115,160,0.55)';
      ctx.stroke();
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px + S * 0.008, py + S * 0.008) : ctx.lineTo(px + S * 0.008, py + S * 0.008)));
      ctx.lineWidth = S * 0.007;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawLicoriceCage(ctx: Ctx, S: number): void {
  const bars: Array<{ dir: 1 | -1; off: number }> = [
    { dir: 1, off: -0.2 },
    { dir: 1, off: 0.2 },
    { dir: -1, off: -0.2 },
    { dir: -1, off: 0.2 },
  ];
  const clip = new Path2D();
  roundRectPath(clip, S * 0.04, S * 0.04, S * 0.92, S * 0.92, S * 0.16);
  const barPath = (dir: 1 | -1, off: number, t0 = 0, t1 = 1): Path2D => {
    // Bar runs diagonally through the cell, offset perpendicular by `off`.
    const p = new Path2D();
    const h = Math.SQRT1_2;
    // dir 1 runs top-left → bottom-right, dir -1 runs bottom-left → top-right.
    const dx = h;
    const dy = dir === 1 ? h : -h;
    const nx = dir === 1 ? h : h;
    const ny = dir === 1 ? -h : h;
    const cx = S * 0.5 + nx * off * S;
    const cy = S * 0.5 + ny * off * S;
    const L = S * 0.75;
    p.moveTo(cx + dx * L * (t0 * 2 - 1), cy + dy * L * (t0 * 2 - 1));
    p.lineTo(cx + dx * L * (t1 * 2 - 1), cy + dy * L * (t1 * 2 - 1));
    return p;
  };
  const strokeBar = (p: Path2D) => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = S * 0.035;
    ctx.shadowOffsetY = S * 0.02;
    ctx.lineWidth = S * 0.115;
    ctx.strokeStyle = '#1d0d16';
    ctx.stroke(p);
    ctx.restore();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = S * 0.085;
    ctx.strokeStyle = '#3a1a2c';
    ctx.stroke(p);
    ctx.setLineDash([S * 0.025, S * 0.03]);
    ctx.lineWidth = S * 0.07;
    ctx.strokeStyle = 'rgba(110,50,85,0.55)';
    ctx.stroke(p);
    ctx.setLineDash([]);
    ctx.lineWidth = S * 0.018;
    ctx.strokeStyle = 'rgba(255,210,235,0.55)';
    ctx.translate(-S * 0.012, -S * 0.012);
    ctx.stroke(p);
    ctx.restore();
  };
  ctx.save();
  ctx.clip(clip);
  // Under bars (dir -1), over bars (dir 1), then re-weave two crossings.
  strokeBar(barPath(-1, bars[2].off));
  strokeBar(barPath(-1, bars[3].off));
  strokeBar(barPath(1, bars[0].off));
  strokeBar(barPath(1, bars[1].off));
  strokeBar(barPath(-1, bars[2].off, 0.36, 0.64));
  ctx.restore();
  // Glossy frame border.
  ctx.save();
  const frame = new Path2D();
  roundRectPath(frame, S * 0.06, S * 0.06, S * 0.88, S * 0.88, S * 0.15);
  ctx.lineWidth = S * 0.05;
  ctx.strokeStyle = 'rgba(30,12,22,0.85)';
  ctx.stroke(frame);
  ctx.lineWidth = S * 0.014;
  ctx.strokeStyle = 'rgba(255,200,230,0.4)';
  ctx.stroke(frame);
  ctx.restore();
  // Rivets.
  for (const [x, y] of [
    [0.5, 0.22],
    [0.5, 0.78],
    [0.22, 0.5],
    [0.78, 0.5],
  ] as Pt[]) {
    const g = ctx.createRadialGradient(S * x - S * 0.01, S * y - S * 0.01, 0, S * x, S * y, S * 0.04);
    g.addColorStop(0, '#ffd3ea');
    g.addColorStop(0.4, '#8a3c66');
    g.addColorStop(1, '#2a0f1e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(S * x, S * y, S * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawChocolateTile(ctx: Ctx, S: number): void {
  const outer = new Path2D();
  roundRectPath(outer, S * 0.05, S * 0.05, S * 0.9, S * 0.9, S * 0.13);
  ctx.save();
  ctx.shadowColor = 'rgba(30,10,0,0.5)';
  ctx.shadowBlur = S * 0.06;
  ctx.shadowOffsetY = S * 0.035;
  const og = ctx.createLinearGradient(0, S * 0.05, 0, S * 0.95);
  og.addColorStop(0, '#7a4528');
  og.addColorStop(1, '#2e1408');
  ctx.fillStyle = og;
  ctx.fill(outer);
  ctx.restore();
  // Four scored squares, each beveled.
  const pad = S * 0.11;
  const gap = S * 0.05;
  const cw = (S - pad * 2 - gap) / 2;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const x = pad + c * (cw + gap);
      const y = pad + r * (cw + gap);
      const p = new Path2D();
      roundRectPath(p, x, y, cw, cw, S * 0.06);
      const fg = ctx.createLinearGradient(x, y, x + cw, y + cw);
      fg.addColorStop(0, '#9a5a34');
      fg.addColorStop(0.45, '#6a3519');
      fg.addColorStop(1, '#3d1c0b');
      ctx.fillStyle = fg;
      ctx.fill(p);
      ctx.save();
      ctx.clip(p);
      ctx.lineWidth = S * 0.03;
      ctx.strokeStyle = 'rgba(20,6,0,0.5)';
      ctx.translate(S * 0.01, S * 0.012);
      ctx.stroke(p);
      ctx.restore();
      ctx.lineWidth = S * 0.01;
      ctx.strokeStyle = 'rgba(230,160,110,0.45)';
      ctx.stroke(p);
    }
  }
  // Warm cocoa highlight + gloss.
  ctx.save();
  ctx.clip(outer);
  const warm = ctx.createRadialGradient(S * 0.3, S * 0.25, 0, S * 0.3, S * 0.25, S * 0.5);
  warm.addColorStop(0, 'rgba(214,140,88,0.45)');
  warm.addColorStop(1, 'rgba(214,140,88,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  const gloss = new Path2D();
  gloss.moveTo(S * 0.1, S * 0.36);
  gloss.quadraticCurveTo(S * 0.14, S * 0.12, S * 0.42, S * 0.1);
  gloss.lineTo(S * 0.3, S * 0.1);
  gloss.quadraticCurveTo(S * 0.12, S * 0.12, S * 0.1, S * 0.26);
  gloss.closePath();
  ctx.fillStyle = 'rgba(255,230,210,0.55)';
  ctx.fill(gloss);
  ctx.restore();
  ctx.lineWidth = S * 0.012;
  ctx.strokeStyle = 'rgba(255,200,160,0.35)';
  ctx.stroke(outer);
}

/* -------------------------------------------------------------------------- */
/* Overlays: jelly, badges, glows                                              */
/* -------------------------------------------------------------------------- */

function drawJelly(ctx: Ctx, S: number, layers: 1 | 2): void {
  const p = new Path2D();
  roundRectPath(p, S * 0.045, S * 0.045, S * 0.91, S * 0.91, S * 0.2);
  const g = ctx.createLinearGradient(0, S * 0.05, 0, S * 0.95);
  if (layers === 1) {
    g.addColorStop(0, 'rgba(255,170,210,0.55)');
    g.addColorStop(1, 'rgba(255,105,170,0.5)');
  } else {
    g.addColorStop(0, 'rgba(214,40,120,0.85)');
    g.addColorStop(1, 'rgba(130,10,72,0.9)');
  }
  ctx.fillStyle = g;
  ctx.fill(p);
  ctx.save();
  ctx.clip(p);
  ctx.lineWidth = S * 0.05;
  ctx.strokeStyle = layers === 1 ? 'rgba(255,120,180,0.5)' : 'rgba(80,0,40,0.55)';
  ctx.stroke(p);
  const gl = ctx.createLinearGradient(0, S * 0.05, 0, S * 0.45);
  gl.addColorStop(0, `rgba(255,255,255,${layers === 1 ? 0.45 : 0.4})`);
  gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  const top = new Path2D();
  roundRectPath(top, S * 0.12, S * 0.09, S * 0.76, S * 0.3, S * 0.14);
  ctx.fill(top);
  ctx.restore();
  ctx.lineWidth = S * 0.014;
  ctx.strokeStyle = layers === 1 ? 'rgba(255,225,240,0.75)' : 'rgba(255,160,210,0.7)';
  ctx.stroke(p);
}

function badgePath(color: CandyColor, S: number): { path: Path2D; ring: boolean } {
  const cx = S * 0.5;
  const cy = S * 0.5;
  const r = S * 0.13;
  const p = new Path2D();
  switch (color) {
    case 'red': // droplet
      p.moveTo(cx, cy - r * 1.25);
      p.bezierCurveTo(cx + r * 0.3, cy - r * 0.6, cx + r, cy - r * 0.05, cx + r, cy + r * 0.3);
      p.arc(cx, cy + r * 0.3, r, 0, Math.PI);
      p.bezierCurveTo(cx - r, cy - r * 0.05, cx - r * 0.3, cy - r * 0.6, cx, cy - r * 1.25);
      p.closePath();
      return { path: p, ring: false };
    case 'orange': // diamond
      p.moveTo(cx, cy - r * 1.2);
      p.lineTo(cx + r * 0.95, cy);
      p.lineTo(cx, cy + r * 1.2);
      p.lineTo(cx - r * 0.95, cy);
      p.closePath();
      return { path: p, ring: false };
    case 'yellow':
      return { path: roundedPolygon(starPoints(S, 0.5, 0.51, 0.16, 0.075), [S * 0.012, S * 0.01]), ring: false };
    case 'green':
      roundRectPath(p, cx - r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8, r * 0.25);
      return { path: p, ring: false };
    case 'blue':
      p.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      return { path: p, ring: true };
    case 'purple': {
      const pts: Pt[] = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        pts.push([cx + Math.cos(a) * r * 1.05, cy + Math.sin(a) * r * 1.05]);
      }
      return { path: roundedPolygon(pts, [S * 0.01]), ring: false };
    }
  }
}

function drawBadge(ctx: Ctx, S: number, color: CandyColor): void {
  const { path, ring } = badgePath(color, S);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = S * 0.03;
  if (ring) {
    ctx.lineWidth = S * 0.075;
    ctx.strokeStyle = 'rgba(15,8,30,0.6)';
    ctx.stroke(path);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = S * 0.035;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(path);
  } else {
    ctx.fillStyle = 'rgba(15,8,30,0.55)';
    ctx.fill(path);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = S * 0.028;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(path);
  }
  ctx.restore();
}

function drawGlow(ctx: Ctx, S: number, color: string): void {
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, withAlpha(color, 0.9));
  g.addColorStop(0.35, withAlpha(color, 0.45));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
}

/* -------------------------------------------------------------------------- */
/* Atlas                                                                       */
/* -------------------------------------------------------------------------- */

export type BlockerSpriteKind = 'frosting-1' | 'frosting-2' | 'frosting-3' | 'locked' | 'chocolate';

export function candySpriteKey(candy: Candy): string {
  if (candy.ingredient) return `ing:${candy.ingredient}`;
  if (candy.special === 'color-bomb') return 'bomb';
  return `${candy.color}:${candy.special}`;
}

export class CandySpriteAtlas {
  private cache = new Map<string, HTMLCanvasElement>();
  private px = 0;
  private dpr = 1;
  private cell = 0;

  constructor(cellSize = 64, dpr = 1) {
    this.ensure(cellSize, dpr);
  }

  /** Re-bakes lazily when the device-pixel sprite size changes. Returns true if the cache was flushed. */
  ensure(cellSize: number, dpr: number): boolean {
    const px = Math.max(8, Math.ceil(cellSize * dpr));
    this.cell = cellSize;
    if (px === this.px && dpr === this.dpr) return false;
    this.px = px;
    this.dpr = dpr;
    this.cache.clear();
    return true;
  }

  get pixelSize(): number {
    return this.px;
  }

  get cellSize(): number {
    return this.cell;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  clear(): void {
    this.cache.clear();
  }

  /** Bakes every common sprite up front so the first cascade never stutters. */
  prewarm(colors: readonly CandyColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']): void {
    for (const color of colors) {
      for (const special of ['none', 'striped-h', 'striped-v', 'wrapped'] as const) {
        this.getCandy({ id: -1, color, special });
      }
      this.getColorblindBadge(color);
    }
    this.getCandy({ id: -1, color: 'none', special: 'color-bomb' });
    this.getIngredient('cherry');
    this.getIngredient('hazelnut');
    this.getBlocker('frosting-1');
    this.getBlocker('frosting-2');
    this.getBlocker('frosting-3');
    this.getBlocker('locked');
    this.getBlocker('chocolate');
    this.getJelly(1);
    this.getJelly(2);
  }

  getCandy(candy: Candy): HTMLCanvasElement {
    if (candy.ingredient) return this.getIngredient(candy.ingredient);
    const key = candySpriteKey(candy);
    return this.bake(key, (ctx, S) => {
      if (candy.special === 'color-bomb') {
        drawColorBomb(ctx, S);
        return;
      }
      if (candy.color === 'none') {
        const g: BodyGeom = { cx: S * 0.5, cy: S * 0.5, r: S * 0.36 };
        const p = circlePath(g.cx, g.cy, g.r);
        bodyBase(ctx, S, p, NEUTRAL_PAL, g);
        specular(ctx, S, p, g);
        return;
      }
      switch (candy.special) {
        case 'striped-h':
          drawStriped(ctx, S, candy.color, 'h');
          break;
        case 'striped-v':
          drawStriped(ctx, S, candy.color, 'v');
          break;
        case 'wrapped':
          drawWrapped(ctx, S, candy.color);
          break;
        default:
          drawRegular(ctx, S, candy.color);
      }
    });
  }

  getIngredient(type: IngredientType): HTMLCanvasElement {
    return this.bake(`ing:${type}`, (ctx, S) => (type === 'cherry' ? drawCherry(ctx, S) : drawHazelnut(ctx, S)));
  }

  getBlocker(kind: BlockerSpriteKind): HTMLCanvasElement {
    return this.bake(`blk:${kind}`, (ctx, S) => {
      switch (kind) {
        case 'frosting-1':
          drawFrosting(ctx, S, 1);
          break;
        case 'frosting-2':
          drawFrosting(ctx, S, 2);
          break;
        case 'frosting-3':
          drawFrosting(ctx, S, 3);
          break;
        case 'locked':
          drawLicoriceCage(ctx, S);
          break;
        case 'chocolate':
          drawChocolateTile(ctx, S);
          break;
      }
    });
  }

  getFrosting(layers: 1 | 2 | 3): HTMLCanvasElement {
    return this.getBlocker(`frosting-${layers}` as BlockerSpriteKind);
  }

  getJelly(layers: 1 | 2): HTMLCanvasElement {
    return this.bake(`jelly:${layers}`, (ctx, S) => drawJelly(ctx, S, layers));
  }

  getColorblindBadge(color: CandyColor): HTMLCanvasElement {
    return this.bake(`badge:${color}`, (ctx, S) => drawBadge(ctx, S, color));
  }

  /** Soft radial glow sprite (halos, auras, comet heads). */
  getGlow(color: string): HTMLCanvasElement {
    return this.bake(`glow:${color}`, (ctx, S) => drawGlow(ctx, S, color));
  }

  private bake(key: string, draw: (ctx: Ctx, S: number) => void): HTMLCanvasElement {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const [canvas, ctx] = makeCanvas(this.px);
    ctx.imageSmoothingEnabled = true;
    draw(ctx, this.px);
    this.cache.set(key, canvas);
    return canvas;
  }
}
