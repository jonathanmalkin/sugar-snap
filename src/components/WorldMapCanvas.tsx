import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { ChapterDef } from '../engine/types';

/*
 * Sugar Snap world map: a full-bleed illustrated confectionery panorama.
 *
 *  - `buildWorldLayout` places every level, chapter signpost and biome band in
 *    real pixels for the current viewport width (y never depends on width, so
 *    rotating the iPad keeps the scroll position meaningful).
 *  - `WorldMapCanvas` paints the static scenery + glazed road as one crisp SVG,
 *    with the few moving parts (clouds, jelly ripples, caramel falls, starlight)
 *    as tiny composited sprites so Safari never repaints the whole panorama.
 *  - `WorldParticles` is a viewport-sized high-DPI canvas for ambient particles
 *    (sparkles, jelly bubbles, sugar snow, sun motes, starlight) that stay
 *    pinned to the world while you scroll.
 */

export type BiomeKind = 'meadow' | 'jelly' | 'frosting' | 'orchard' | 'palace';

const BIOME_ORDER: BiomeKind[] = ['meadow', 'jelly', 'frosting', 'orchard', 'palace'];

export function biomeForChapter(index: number): BiomeKind {
  return BIOME_ORDER[((index % BIOME_ORDER.length) + BIOME_ORDER.length) % BIOME_ORDER.length] ?? 'meadow';
}

export interface Pt {
  x: number;
  y: number;
}

export interface WorldNode extends Pt {
  levelId: number;
  chapterIndex: number;
  indexInChapter: number;
}

export interface WorldBand {
  chapterIndex: number;
  biome: BiomeKind;
  top: number;
  bottom: number;
}

export interface WorldSign extends Pt {
  chapterIndex: number;
  side: 'left' | 'right';
  width: number;
}

export interface WorldLayout {
  width: number;
  height: number;
  nodes: WorldNode[];
  bands: WorldBand[];
  signs: WorldSign[];
  /** Road control points: entry, every level, palace gate. */
  road: Pt[];
  /** Dense samples along the road (monotonic in y). */
  samples: Pt[];
  gate: Pt;
}

/* ---------- geometry ---------- */

const STEP = 150;
const CH_GAP = 300;
const TOP = 330;
const BOTTOM = 440;
const SIGN_LIFT = 132;
/** Winding pattern (in amplitude units) for a five-level chapter; mirrored on odd chapters. */
const PATTERN5 = [-0.72, 0.36, 0.9, -0.08, 0.74];

function patternAt(i: number, n: number): number {
  if (n === 5) return PATTERN5[i] ?? 0;
  const t = n <= 1 ? 0 : i / (n - 1);
  return -0.74 * Math.cos(3 * Math.PI * t);
}

function catmull(points: Pt[]): Array<[Pt, Pt, Pt, Pt]> {
  const segs: Array<[Pt, Pt, Pt, Pt]> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segs.push([p1, c1, c2, p2]);
  }
  return segs;
}

function smoothPath(points: Pt[], segmentLimit = Infinity): string {
  if (points.length === 0) return '';
  const segs = catmull(points).slice(0, segmentLimit);
  const first = points[0];
  let d = `M${r1(first.x)} ${r1(first.y)}`;
  for (const [, c1, c2, p2] of segs) {
    d += ` C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(p2.x)} ${r1(p2.y)}`;
  }
  return d;
}

function bezierAt([p1, c1, c2, p2]: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p1.x + b * c1.x + c * c2.x + d * p2.x, y: a * p1.y + b * c1.y + c * c2.y + d * p2.y };
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function roadXAt(samples: Pt[], y: number): number {
  if (samples.length === 0) return 0;
  if (y <= samples[0].y) return samples[0].x;
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    if (b.y >= y) {
      const a = samples[i - 1];
      const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
      return a.x + (b.x - a.x) * t;
    }
  }
  return samples[samples.length - 1].x;
}

export function buildWorldLayout(width: number, chapters: Pick<ChapterDef, 'levelIds'>[]): WorldLayout {
  const W = Math.max(320, width);
  const cx = W / 2;
  const amp = Math.max(90, Math.min(W * 0.34, 430, (W / 2 - 62) / 0.9));

  const nodes: WorldNode[] = [];
  const firstY: number[] = [];
  const lastY: number[] = [];
  let y = TOP;
  chapters.forEach((chapter, c) => {
    const s = c % 2 === 0 ? 1 : -1;
    const n = chapter.levelIds.length;
    if (c > 0) y += CH_GAP - STEP;
    firstY[c] = y;
    chapter.levelIds.forEach((levelId, i) => {
      nodes.push({ levelId, chapterIndex: c, indexInChapter: i, x: cx + s * patternAt(i, n) * amp, y });
      lastY[c] = y;
      y += STEP;
    });
    if (n === 0) lastY[c] = y;
  });

  const lastNode = nodes[nodes.length - 1];
  const endY = lastNode ? lastNode.y : TOP;
  const height = endY + BOTTOM;
  const gate: Pt = { x: cx, y: endY + 215 };

  const firstNode = nodes[0];
  const road: Pt[] = [
    { x: (firstNode?.x ?? cx) + amp * 0.62, y: -70 },
    ...nodes.map((nd) => ({ x: nd.x, y: nd.y })),
    gate,
  ];

  const samples: Pt[] = [];
  for (const seg of catmull(road)) {
    for (let k = 0; k < 18; k++) samples.push(bezierAt(seg, k / 18));
  }
  samples.push(gate);

  const bands: WorldBand[] = chapters.map((_, c) => {
    const top = c === 0 ? 0 : (lastY[c - 1] ?? 0) + ((firstY[c] ?? 0) - (lastY[c - 1] ?? 0)) * 0.26;
    return { chapterIndex: c, biome: biomeForChapter(c), top, bottom: height };
  });
  for (let c = 0; c < bands.length - 1; c++) bands[c].bottom = bands[c + 1].top;

  const signW = Math.round(Math.max(214, Math.min(W * 0.27, 280)));
  const signs: WorldSign[] = chapters.map((_, c) => {
    const sy = (firstY[c] ?? TOP) - SIGN_LIFT;
    const rx = roadXAt(samples, sy);
    const side: 'left' | 'right' = rx < cx ? 'right' : 'left';
    const margin = 16;
    const x =
      side === 'right'
        ? Math.min(W - margin - signW, rx + 66)
        : Math.max(margin, rx - 66 - signW);
    return { chapterIndex: c, side, width: signW, x, y: sy };
  });

  return { width: W, height, nodes, bands, signs, road, samples, gate };
}

/* ---------- seeded randomness + color ---------- */

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[c(ar, br), c(ag, bg), c(ab, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/* ---------- biome art direction ---------- */

interface BiomeArt {
  sky: [string, string];
  hills: Array<[string, string]>;
  sheen: string;
  sheenOpacity: number;
  shadow: string;
}

const ART: Record<BiomeKind, BiomeArt> = {
  meadow: {
    sky: ['#fff4f6', '#ffe3ea'],
    hills: [
      ['#ffd6e1', '#ffb7ca'],
      ['#fff3e2', '#ffe2c6'],
      ['#dcf6df', '#b9ecc7'],
      ['#ffc9d8', '#ffa3bd'],
    ],
    sheen: '#ffffff',
    sheenOpacity: 0.7,
    shadow: 'rgba(150, 52, 84, 0.20)',
  },
  jelly: {
    sky: ['#e8fbf0', '#d2f3e4'],
    hills: [
      ['#cbf4df', '#a2e7c4'],
      ['#e6faee', '#c6f0d9'],
      ['#f4daee', '#e8b9dc'],
      ['#b9edd6', '#8edcbb'],
    ],
    sheen: '#ffffff',
    sheenOpacity: 0.7,
    shadow: 'rgba(40, 110, 84, 0.20)',
  },
  frosting: {
    sky: ['#f0f1ff', '#dfe3ff'],
    hills: [
      ['#ffffff', '#eef0ff'],
      ['#f7f8ff', '#e4e7ff'],
    ],
    sheen: '#ffffff',
    sheenOpacity: 0.9,
    shadow: 'rgba(72, 72, 150, 0.20)',
  },
  orchard: {
    sky: ['#ffeed6', '#ffd9b8'],
    hills: [
      ['#ffd9ac', '#ffbe82'],
      ['#ffcfb0', '#ffab89'],
      ['#f8e4ab', '#eec97a'],
      ['#ffd4bd', '#f6ae93'],
    ],
    sheen: '#fff6d8',
    sheenOpacity: 0.75,
    shadow: 'rgba(150, 74, 30, 0.22)',
  },
  palace: {
    sky: ['#6e3d57', '#3a1d2c'],
    hills: [
      ['#7d4259', '#5d2c42'],
      ['#6b374d', '#4c2436'],
      ['#8c4b62', '#66324a'],
    ],
    sheen: '#ffc983',
    sheenOpacity: 0.42,
    shadow: 'rgba(20, 6, 12, 0.36)',
  },
};

const ROW = 156;

interface HillRow {
  key: string;
  d: string;
  edge: string;
  light: string;
  base: string;
  sheen: string;
  sheenOpacity: number;
}

function hillRows(band: WorldBand, prev: WorldBand | undefined, W: number, seed: number): HillRow[] {
  const art = ART[band.biome];
  const prevArt = prev ? ART[prev.biome] : undefined;
  const rand = mulberry(seed);
  const rows: HillRow[] = [];
  const count = Math.max(1, Math.ceil((band.bottom - band.top) / ROW));
  for (let i = 0; i < count; i++) {
    const yTop = band.top + i * ROW - 26;
    const amp1 = 18 + rand() * 18;
    const amp2 = 8 + rand() * 10;
    const f1 = 1.2 + rand() * 1.4;
    const f2 = 3 + rand() * 2.5;
    const ph1 = rand() * Math.PI * 2;
    const ph2 = rand() * Math.PI * 2;
    const pts: Pt[] = [];
    for (let x = -40; x <= W + 40; x += 48) {
      const u = x / W;
      pts.push({
        x,
        y: yTop + amp1 * Math.sin(u * Math.PI * 2 * f1 + ph1) + amp2 * Math.sin(u * Math.PI * 2 * f2 + ph2),
      });
    }
    const edge = smoothPath(pts);
    const depth = ROW + 120;
    const d = `${edge} L${W + 40} ${r1(yTop + depth)} L-40 ${r1(yTop + depth)} Z`;
    const pal = art.hills[i % art.hills.length];
    let [light, base] = pal;
    // Blend the first rows with the previous biome so regions melt together.
    if (prevArt && i < 2) {
      const pp = prevArt.hills[(i + 1) % prevArt.hills.length];
      const t = i === 0 ? 0.45 : 0.78;
      light = mix(pp[0], light, t);
      base = mix(pp[1], base, t);
    }
    rows.push({ key: `${band.chapterIndex}-${i}`, d, edge, light, base, sheen: art.sheen, sheenOpacity: art.sheenOpacity });
  }
  return rows;
}

interface Mountain {
  key: string;
  body: string;
  facet: string;
  cap: string;
  fill: string;
}

function mountainRows(band: WorldBand, W: number, seed: number): Mountain[][] {
  const rand = mulberry(seed);
  const rows: Mountain[][] = [];
  const count = Math.max(1, Math.ceil((band.bottom - band.top) / ROW));
  const tones = ['#c9cdfa', '#b4baf2', '#d8dbff', '#a9b0ee'];
  for (let i = 0; i < count; i++) {
    const base = band.top + i * ROW + 40;
    const row: Mountain[] = [];
    let x = -80 + rand() * 60;
    let k = 0;
    while (x < W + 80) {
      const half = 80 + rand() * 70;
      const h = 110 + rand() * 90;
      const px = x + half;
      const py = base - h;
      const l = x;
      const r = x + half * 2;
      const body = `M${r1(l)} ${r1(base)} L${r1(px - 10)} ${r1(py + 12)} Q${r1(px)} ${r1(py - 4)} ${r1(px + 10)} ${r1(py + 12)} L${r1(r)} ${r1(base)} Z`;
      const facet = `M${r1(px + 6)} ${r1(py + 8)} Q${r1(px + 4)} ${r1(py + h * 0.55)} ${r1(px - half * 0.25)} ${r1(base)} L${r1(r)} ${r1(base)} Z`;
      // Frosting cap with icing drips.
      const f = 0.4 + rand() * 0.12;
      const lx = px + (l - px) * f;
      const ly = py + (base - py) * f;
      const rx = px + (r - px) * f;
      const ry = py + (base - py) * f;
      let cap = `M${r1(lx)} ${r1(ly)} L${r1(px - 10)} ${r1(py + 12)} Q${r1(px)} ${r1(py - 4)} ${r1(px + 10)} ${r1(py + 12)} L${r1(rx)} ${r1(ry)}`;
      const drips = 3 + Math.floor(rand() * 3);
      for (let dIdx = drips; dIdx >= 1; dIdx--) {
        const t0 = dIdx / drips;
        const t1 = (dIdx - 1) / drips;
        const ax = lx + (rx - lx) * t0;
        const ay = ly + (ry - ly) * t0;
        const bx = lx + (rx - lx) * t1;
        const by = ly + (ry - ly) * t1;
        const mx = (ax + bx) / 2;
        const drop = 10 + rand() * 22;
        cap += ` Q${r1(ax)} ${r1(ay + drop * 1.1)} ${r1(mx)} ${r1((ay + by) / 2 + drop)} Q${r1(bx)} ${r1(by + drop * 1.1)} ${r1(bx)} ${r1(by)}`;
      }
      cap += ' Z';
      row.push({ key: `${band.chapterIndex}-${i}-${k}`, body, facet, cap, fill: tones[(i + k) % tones.length] });
      x = r - half * (0.55 + rand() * 0.3);
      k++;
    }
    rows.push(row);
  }
  return rows;
}

/* ---------- props ---------- */

type PropKind =
  | 'lollipop'
  | 'cupcake'
  | 'gumdrop'
  | 'flowers'
  | 'pond'
  | 'jellybush'
  | 'stones'
  | 'pine'
  | 'cane'
  | 'snowmound'
  | 'cherrytree'
  | 'hazeltree'
  | 'spire'
  | 'truffle';

interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  r: number;
  tint: string;
  flip: boolean;
}

interface PropSpec {
  kind: PropKind;
  r: [number, number];
  weight: number;
}

const PROPS: Record<BiomeKind, PropSpec[]> = {
  meadow: [
    { kind: 'lollipop', r: [30, 44], weight: 4 },
    { kind: 'cupcake', r: [26, 34], weight: 3 },
    { kind: 'gumdrop', r: [16, 24], weight: 3 },
    { kind: 'flowers', r: [14, 20], weight: 4 },
  ],
  jelly: [
    { kind: 'pond', r: [58, 92], weight: 3 },
    { kind: 'jellybush', r: [24, 34], weight: 4 },
    { kind: 'stones', r: [18, 26], weight: 3 },
    { kind: 'gumdrop', r: [16, 22], weight: 2 },
  ],
  frosting: [
    { kind: 'pine', r: [26, 40], weight: 6 },
    { kind: 'cane', r: [18, 26], weight: 2 },
    { kind: 'snowmound', r: [20, 30], weight: 3 },
  ],
  orchard: [
    { kind: 'cherrytree', r: [36, 50], weight: 5 },
    { kind: 'hazeltree', r: [32, 44], weight: 3 },
    { kind: 'flowers', r: [14, 20], weight: 2 },
  ],
  palace: [
    { kind: 'spire', r: [30, 46], weight: 2 },
    { kind: 'truffle', r: [18, 26], weight: 2 },
  ],
};

const TINTS: Record<BiomeKind, string[]> = {
  meadow: ['#ff6f95', '#ffb703', '#7fd3aa', '#b48cff', '#ff8f6b'],
  jelly: ['#e24f8f', '#9b5de5', '#2cbf78', '#ff6f95'],
  frosting: ['#e6396b', '#5fd3a3', '#7a8cff'],
  orchard: ['#d4122f', '#e6396b', '#ff8a1f'],
  palace: ['#7a2846', '#c07a3a', '#9b4d8c'],
};

function pickSpec(specs: PropSpec[], rand: () => number): PropSpec {
  const total = specs.reduce((n, s) => n + s.weight, 0);
  let roll = rand() * total;
  for (const s of specs) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return specs[0];
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

function scatterProps(layout: WorldLayout, signRects: Rect[]): Prop[] {
  const { width: W, bands, samples, nodes } = layout;
  const out: Prop[] = [];
  bands.forEach((band) => {
    const rand = mulberry(7919 + band.chapterIndex * 104729);
    const specs = PROPS[band.biome];
    const tints = TINTS[band.biome];
    const area = W * (band.bottom - band.top);
    const target = Math.round(area / (band.biome === 'palace' ? 34000 : 21000));
    let placed = 0;
    for (let attempt = 0; attempt < target * 8 && placed < target; attempt++) {
      const spec = pickSpec(specs, rand);
      const r = spec.r[0] + rand() * (spec.r[1] - spec.r[0]);
      const x = -r * 0.3 + rand() * (W + r * 0.6);
      const y = band.top + 40 + rand() * (band.bottom - band.top - 60);
      const cyBody = spec.kind === 'pond' || spec.kind === 'stones' ? y : y - r;
      const reach = spec.kind === 'pond' ? r * 0.55 : r;
      // Keep the road clear.
      let ok = true;
      for (const s of samples) {
        if (Math.abs(s.y - cyBody) > reach + 70) continue;
        const dx = (s.x - x) / (spec.kind === 'pond' ? r / reach : 1);
        if (Math.hypot(dx, s.y - cyBody) < reach + 44) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Keep medallions, crowns, flags and pins clear.
      for (const n of nodes) {
        if (Math.abs(n.x - x) < 70 + reach && cyBody > n.y - 130 - reach && cyBody < n.y + 72 + reach) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const sr of signRects) {
        if (x + reach > sr.l - 10 && x - reach < sr.r + 10 && y > sr.t - 6 && y - 2 * r < sr.b + 10) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const p of out) {
        const pr = p.kind === 'pond' ? p.r * 0.7 : p.r;
        if (Math.hypot(p.x - x, (p.y - y) * 1.3) < (pr + reach) * 0.92) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push({ kind: spec.kind, x, y, r, tint: tints[Math.floor(rand() * tints.length)] ?? tints[0], flip: rand() > 0.5 });
      placed++;
    }
  });
  // Ponds lie flat on the ground; everything else is depth-sorted by its foot.
  return out.sort((a, b) => (a.kind === 'pond' ? -1 : 0) - (b.kind === 'pond' ? -1 : 0) || a.y - b.y);
}

function Shadow({ rx, ry = rx * 0.26, color }: { rx: number; ry?: number; color: string }): ReactElement {
  return <ellipse cx="0" cy="2" rx={rx} ry={ry} fill={color} />;
}

function spiral(): string {
  let d = '';
  for (let t = 0; t <= Math.PI * 4.2; t += 0.3) {
    const rr = 2 + t * 2.75;
    const x = Math.cos(t) * rr;
    const y = -100 + Math.sin(t) * rr;
    d += `${d ? ' L' : 'M'}${r1(x)} ${r1(y)}`;
  }
  return d;
}
const SPIRAL_D = spiral();

function PropArt({ p, shadow }: { p: Prop; shadow: string }): ReactElement | null {
  const s = p.r / 50;
  const t = `translate(${r1(p.x)} ${r1(p.y)}) scale(${(p.flip ? -s : s).toFixed(3)} ${s.toFixed(3)})`;
  switch (p.kind) {
    case 'lollipop':
      return (
        <g transform={t}>
          <Shadow rx={30} color={shadow} />
          <rect x="-5" y="-64" width="10" height="64" rx="5" fill="#fff6ec" stroke="#d9b79a" strokeWidth="2" />
          <path d="M-5 -50 L5 -56 M-5 -34 L5 -40 M-5 -18 L5 -24" stroke="#ff9db6" strokeWidth="3" />
          <circle cx="0" cy="-100" r="40" fill={p.tint} />
          <circle cx="0" cy="-100" r="40" fill="url(#wm-orb)" />
          <path d={SPIRAL_D} fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" opacity="0.88" />
          <ellipse cx="-15" cy="-120" rx="14" ry="7" fill="#fff" opacity="0.7" transform="rotate(-32 -15 -120)" />
        </g>
      );
    case 'cupcake':
      return (
        <g transform={t}>
          <Shadow rx={30} color={shadow} />
          <path d="M-28 -40 H28 L21 0 H-21 Z" fill="#f2c79a" stroke="#c98a5e" strokeWidth="2.5" />
          <path d="M-14 -38 L-11 -2 M0 -38 V-2 M14 -38 L11 -2" stroke="#c98a5e" strokeWidth="2.5" />
          <path d="M-34 -38 C-42 -52 -30 -66 -18 -62 C-16 -80 4 -86 14 -74 C28 -80 40 -64 32 -54 C42 -50 40 -38 34 -36 Z" fill={p.tint} />
          <path d="M-34 -38 C-42 -52 -30 -66 -18 -62 C-16 -80 4 -86 14 -74 C28 -80 40 -64 32 -54 C42 -50 40 -38 34 -36 Z" fill="url(#wm-orb)" />
          <circle cx="2" cy="-86" r="9" fill="#e6396b" />
          <ellipse cx="-1" cy="-89" rx="3" ry="2" fill="#fff" opacity="0.8" />
          <path d="M2 -95 C2 -101 6 -104 11 -105" stroke="#3f7d2a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <ellipse cx="-16" cy="-62" rx="9" ry="4" fill="#fff" opacity="0.6" transform="rotate(-20 -16 -62)" />
          {[-20, -6, 10, 22].map((sx, i) => (
            <rect key={i} x={sx} y={-52 + (i % 2) * 8} width="6" height="2.6" rx="1.3" fill={['#fff', '#ffd860', '#7fd3aa', '#fff'][i]} transform={`rotate(${i * 40 - 30} ${sx} -50)`} />
          ))}
        </g>
      );
    case 'gumdrop':
      return (
        <g transform={t}>
          <Shadow rx={42} color={shadow} />
          <path d="M-44 0 C-44 -40 -26 -74 0 -74 C26 -74 44 -40 44 0 Z" fill={p.tint} />
          <path d="M-44 0 C-44 -40 -26 -74 0 -74 C26 -74 44 -40 44 0 Z" fill="url(#wm-orb)" />
          {[
            [-18, -40],
            [8, -52],
            [20, -24],
            [-4, -18],
            [-26, -16],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="3.4" fill="#fff" opacity="0.85" />
          ))}
          <ellipse cx="-16" cy="-56" rx="12" ry="5" fill="#fff" opacity="0.6" transform="rotate(-35 -16 -56)" />
        </g>
      );
    case 'flowers':
      return (
        <g transform={t}>
          {[
            [-30, -6, 1],
            [8, -18, 1.2],
            [36, 0, 0.9],
          ].map(([fx, fy, fs], i) => (
            <g key={i} transform={`translate(${fx} ${fy}) scale(${fs})`}>
              <path d="M0 0 V22" stroke="#5aa25a" strokeWidth="3" />
              {[0, 72, 144, 216, 288].map((a) => (
                <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 9} cy={Math.sin((a * Math.PI) / 180) * 9} r="8" fill={i === 1 ? '#fff' : p.tint} />
              ))}
              <circle r="6" fill="#ffd860" />
            </g>
          ))}
        </g>
      );
    case 'pond':
      return (
        <g transform={`translate(${r1(p.x)} ${r1(p.y)})`}>
          <ellipse rx={p.r + 10} ry={p.r * 0.46 + 7} fill="#e9fbf1" />
          <ellipse rx={p.r + 4} ry={p.r * 0.46 + 3} fill="#b9ecd2" />
          <ellipse rx={p.r} ry={p.r * 0.46} fill="url(#wm-jelly)" />
          <ellipse cx={-p.r * 0.32} cy={-p.r * 0.16} rx={p.r * 0.34} ry={p.r * 0.09} fill="#fff" opacity="0.55" />
          {[
            [-1.05, 0.3],
            [-0.75, 0.56],
            [1.02, -0.18],
          ].map(([fx, fy], i) => (
            <g key={i} transform={`translate(${r1(fx * p.r)} ${r1(fy * p.r)})`}>
              <ellipse rx="11" ry="6" cy="2" fill="rgba(40,110,84,0.22)" />
              <ellipse rx="11" ry="6" fill="#8fe0bd" />
              <ellipse rx="5" ry="2" cx="-3" cy="-2" fill="#fff" opacity="0.7" />
            </g>
          ))}
        </g>
      );
    case 'jellybush':
      return (
        <g transform={t}>
          <Shadow rx={42} color={shadow} />
          {[
            [-24, -26, 24, '#2cbf78'],
            [22, -24, 22, '#3fcf8e'],
            [0, -44, 28, '#27b06e'],
          ].map(([bx, by, br, c], i) => (
            <circle key={i} cx={bx} cy={by} r={br} fill={c as string} />
          ))}
          {[
            [-22, -40, p.tint],
            [10, -58, '#ff6f95'],
            [24, -34, p.tint],
            [-4, -24, '#9b5de5'],
          ].map(([bx, by, c], i) => (
            <g key={i}>
              <circle cx={bx} cy={by} r="9" fill={c as string} opacity="0.92" />
              <circle cx={(bx as number) - 3} cy={(by as number) - 3} r="3" fill="#fff" opacity="0.8" />
            </g>
          ))}
          <ellipse cx="-8" cy="-64" rx="12" ry="5" fill="#fff" opacity="0.45" transform="rotate(-25 -8 -64)" />
        </g>
      );
    case 'stones':
      return (
        <g transform={t}>
          {[
            [-32, 4, 20],
            [6, -6, 16],
            [38, 6, 22],
          ].map(([sx, sy, sr], i) => (
            <g key={i} transform={`translate(${sx} ${sy})`}>
              <ellipse rx={sr} ry={sr * 0.55} cy="3" fill={shadow} />
              <ellipse rx={sr} ry={sr * 0.55} fill="#9fe6c4" />
              <ellipse rx={sr * 0.8} ry={sr * 0.38} cy="-2" fill="#c8f5df" />
              <ellipse rx={sr * 0.35} ry={sr * 0.12} cx={-sr * 0.25} cy={-sr * 0.2} fill="#fff" opacity="0.8" />
            </g>
          ))}
        </g>
      );
    case 'pine':
      return (
        <g transform={t}>
          <Shadow rx={34} color={shadow} />
          <path d="M0 0 V-30" stroke="#fff" strokeWidth="11" />
          <path d="M0 0 V-30" stroke="#e6396b" strokeWidth="11" strokeDasharray="5 5" />
          {[
            [40, -26, -74],
            [32, -54, -96],
            [23, -80, -118],
          ].map(([hw, by, ty], i) => (
            <g key={i}>
              <path d={`M${-hw} ${by} Q0 ${by + 8} ${hw} ${by} L4 ${ty + 3} Q0 ${ty - 2} -4 ${ty + 3} Z`} fill={i % 2 ? '#4fc596' : '#3fb487'} />
              <path d={`M${-hw} ${by} Q0 ${by + 8} ${hw} ${by}`} fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
              <path d={`M${-hw * 0.5} ${by - 10} L-3 ${ty + 10}`} stroke="#fff" strokeWidth="3" opacity="0.4" strokeLinecap="round" />
            </g>
          ))}
          <circle cx="0" cy="-118" r="6" fill="#fff" />
        </g>
      );
    case 'cane':
      return (
        <g transform={t}>
          <Shadow rx={20} color={shadow} />
          <path d="M0 0 V-70 C0 -96 -34 -96 -34 -70" fill="none" stroke="#fff" strokeWidth="13" strokeLinecap="round" />
          <path d="M0 0 V-70 C0 -96 -34 -96 -34 -70" fill="none" stroke={p.tint} strokeWidth="13" strokeLinecap="round" strokeDasharray="7 8" />
          <path d="M-4 -6 V-66" stroke="#fff" strokeWidth="3" opacity="0.6" strokeLinecap="round" />
        </g>
      );
    case 'snowmound':
      return (
        <g transform={t}>
          <Shadow rx={52} ry={10} color={shadow} />
          <path d="M-54 0 C-48 -30 -20 -40 0 -36 C20 -46 52 -30 54 0 Z" fill="#fff" />
          <path d="M10 -36 C30 -40 52 -26 54 0 H18 C30 -14 26 -26 10 -36 Z" fill="#dfe3ff" />
          <ellipse cx="-20" cy="-26" rx="14" ry="4" fill="#fff" opacity="0.9" />
        </g>
      );
    case 'cherrytree':
      return (
        <g transform={t}>
          <Shadow rx={42} color={shadow} />
          <path d="M-6 0 C-4 -24 -8 -40 -2 -56 M4 0 C4 -22 10 -40 4 -56" stroke="#8b5a3c" strokeWidth="9" strokeLinecap="round" fill="none" />
          <circle cx="-26" cy="-78" r="28" fill="#6fae55" />
          <circle cx="26" cy="-80" r="28" fill="#64a34c" />
          <circle cx="0" cy="-104" r="32" fill="#7fbe5f" />
          <circle cx="0" cy="-90" r="40" fill="url(#wm-canopy)" />
          {[
            [-30, -74],
            [-8, -112],
            [22, -96],
            [30, -70],
            [6, -78],
          ].map(([cx, cy], i) => (
            <g key={i}>
              <circle cx={cx - 4} cy={cy} r="6.5" fill={p.tint} />
              <circle cx={cx + 5} cy={cy + 2} r="6.5" fill={p.tint} />
              <circle cx={cx - 6} cy={cy - 2} r="2" fill="#fff" opacity="0.8" />
            </g>
          ))}
          <ellipse cx="-12" cy="-124" rx="14" ry="6" fill="#fff6d8" opacity="0.55" transform="rotate(-20 -12 -124)" />
        </g>
      );
    case 'hazeltree':
      return (
        <g transform={t}>
          <Shadow rx={40} color={shadow} />
          <path d="M0 0 C-2 -24 2 -40 0 -58" stroke="#7a4a2c" strokeWidth="11" strokeLinecap="round" fill="none" />
          <ellipse cx="0" cy="-92" rx="44" ry="40" fill="#c9a24a" />
          <ellipse cx="-14" cy="-104" rx="28" ry="24" fill="#d8b45a" />
          <ellipse cx="0" cy="-92" rx="44" ry="40" fill="url(#wm-canopy)" />
          {[
            [-22, -80],
            [16, -100],
            [24, -74],
            [-4, -66],
          ].map(([hx, hy], i) => (
            <g key={i}>
              <ellipse cx={hx} cy={hy} rx="7" ry="8" fill="#8b5a3c" />
              <path d={`M${hx - 7} ${hy - 4} Q${hx} ${hy - 12} ${hx + 7} ${hy - 4}`} fill="#5aa25a" />
            </g>
          ))}
          <ellipse cx="-18" cy="-118" rx="14" ry="6" fill="#fff6d8" opacity="0.6" transform="rotate(-24 -18 -118)" />
        </g>
      );
    case 'spire':
      return (
        <g transform={t}>
          <Shadow rx={40} color={shadow} />
          <rect x="-24" y="-96" width="48" height="96" rx="6" fill="#5a2e22" />
          <rect x="-24" y="-96" width="16" height="96" fill="#6e3a2a" />
          <path d="M-28 -96 H28 L24 -86 H-24 Z" fill="#c07a3a" />
          {[-60, -30].map((wy) => (
            <path key={wy} d={`M-7 ${wy} V${wy - 10} A7 7 0 0 1 7 ${wy - 10} V${wy} Z`} fill="#ffcf6a" />
          ))}
          <path d="M-30 -96 L0 -156 L30 -96 Z" fill={p.tint} />
          <path d="M0 -156 L30 -96 H8 Z" fill="#000" opacity="0.18" />
          <path d="M-16 -112 L-4 -136" stroke="#fff" strokeWidth="4" opacity="0.35" strokeLinecap="round" />
          <circle cx="0" cy="-160" r="6" fill="#ffd25e" />
          <path d="M0 -166 V-182 L14 -176 L0 -170" fill="#ffb703" stroke="#ffb703" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M-24 -20 H24" stroke="#c07a3a" strokeWidth="5" opacity="0.6" />
        </g>
      );
    case 'truffle':
      return (
        <g transform={t}>
          <Shadow rx={40} color={shadow} />
          <path d="M-36 -24 H36 L28 0 H-28 Z" fill="#c07a3a" />
          <path d="M-24 -22 L-20 -2 M-8 -22 V-2 M8 -22 V-2 M24 -22 L20 -2" stroke="#8b4f22" strokeWidth="2.5" />
          <circle cx="0" cy="-44" r="30" fill="#4a2617" />
          <path d="M-22 -50 C-14 -60 -6 -44 2 -54 S16 -50 22 -56" stroke="#e2b27a" strokeWidth="4" fill="none" strokeLinecap="round" />
          <ellipse cx="-11" cy="-62" rx="9" ry="5" fill="#fff" opacity="0.3" transform="rotate(-30 -11 -62)" />
          <path d="M6 -72 l3 -6 l3 6 l-3 3 z" fill="#ffd25e" />
        </g>
      );
  }
}

/* ---------- animated sprites ---------- */

interface Sprite {
  key: string;
  kind: 'cloud' | 'ripple' | 'fall' | 'twinkle' | 'sun';
  x: number;
  y: number;
  w: number;
  h: number;
  delay: number;
  dur: number;
}

function buildSprites(layout: WorldLayout, props: Prop[]): Sprite[] {
  const { width: W, bands, nodes, samples } = layout;
  const out: Sprite[] = [];
  bands.forEach((band) => {
    const rand = mulberry(31337 + band.chapterIndex * 7121);
    const h = band.bottom - band.top;
    if (band.biome === 'meadow' || band.biome === 'frosting' || band.biome === 'orchard') {
      const n = band.biome === 'meadow' ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const w = 120 + rand() * 90;
        const leftSide = i % 2 === 0;
        const x = leftSide ? -w * 0.25 + rand() * W * 0.12 : W - w * 0.75 - rand() * W * 0.12;
        out.push({
          key: `cloud-${band.chapterIndex}-${i}`,
          kind: 'cloud',
          x,
          y: band.top + 60 + (h - 160) * ((i + rand() * 0.6) / n),
          w,
          h: w * 0.5,
          delay: -rand() * 20,
          dur: 16 + rand() * 12,
        });
      }
    }
    if (band.biome === 'meadow' || band.biome === 'orchard') {
      const size = Math.min(520, W * 0.55);
      out.push({
        key: `sun-${band.chapterIndex}`,
        kind: 'sun',
        x: band.biome === 'meadow' ? W - size * 0.62 : -size * 0.38,
        y: band.top + (band.biome === 'meadow' ? -size * 0.3 : h * 0.2),
        w: size,
        h: size,
        delay: 0,
        dur: 9,
      });
    }
    if (band.biome === 'palace') {
      const count = Math.round((W * h) / 26000);
      for (let i = 0; i < count; i++) {
        const s = 10 + rand() * 14;
        out.push({
          key: `tw-${i}`,
          kind: 'twinkle',
          x: rand() * W,
          y: band.top + rand() * h,
          w: s,
          h: s,
          delay: -rand() * 4,
          dur: 2.4 + rand() * 2.6,
        });
      }
      // Caramel waterfalls pour down the cliffs at the map edges, away from the road.
      [0.22, 0.62].forEach((f, i) => {
        const fy = band.top + h * f;
        const rx = roadXAt(samples, fy + 90);
        const leftEdge = rx > W / 2;
        const w = Math.max(56, Math.min(84, W * 0.07));
        const x = leftEdge ? 18 + W * 0.02 : W - w - 18 - W * 0.02;
        const tooClose = nodes.some((n) => Math.abs(n.x - (x + w / 2)) < w + 60 && n.y > fy - 120 && n.y < fy + 320);
        if (tooClose) return;
        out.push({ key: `fall-${i}`, kind: 'fall', x, y: fy, w, h: 200, delay: 0, dur: 1.6 });
      });
    }
  });
  props
    .filter((p) => p.kind === 'pond')
    .forEach((p, i) => {
      out.push({
        key: `ripple-${i}`,
        kind: 'ripple',
        x: p.x - p.r * 0.7,
        y: p.y - p.r * 0.33,
        w: p.r * 1.4,
        h: p.r * 0.66,
        delay: -((i * 0.9) % 3),
        dur: 3.2,
      });
    });
  return out;
}

function CloudArt(): ReactElement {
  return (
    <svg viewBox="0 0 120 60" aria-hidden="true">
      <ellipse cx="60" cy="54" rx="48" ry="5" fill="rgba(91,46,24,0.08)" />
      <path d="M22 50c-12 0-18-8-16-16 2-9 11-12 18-9 2-12 14-20 27-16 7-8 24-8 31 4 13-2 24 7 22 20-1 10-9 17-20 17z" fill="#fff" />
      <path d="M14 46c20 4 60 4 88 0" stroke="#f3dce8" strokeWidth="4" strokeLinecap="round" opacity="0.7" fill="none" />
    </svg>
  );
}

function SpriteLayer({ sprites }: { sprites: Sprite[] }): ReactElement {
  return (
    <div className="wm-sprites" aria-hidden="true">
      {sprites.map((s) => {
        const style = {
          left: s.x,
          top: s.y,
          width: s.w,
          height: s.h,
          animationDelay: `${s.delay}s`,
          animationDuration: `${s.dur}s`,
        } as CSSProperties;
        let inner: ReactNode = null;
        if (s.kind === 'cloud') inner = <CloudArt />;
        if (s.kind === 'ripple')
          inner = (
            <>
              <span className="wm-ripple__ring" style={{ animationDelay: `${s.delay}s` }} />
              <span className="wm-ripple__ring" style={{ animationDelay: `${s.delay - 1.6}s` }} />
            </>
          );
        if (s.kind === 'fall')
          inner = (
            <>
              <span className="wm-fall__lip" />
              <span className="wm-fall__stream" />
              <span className="wm-fall__pool" />
            </>
          );
        return <span key={s.key} className={`wm-sprite wm-${s.kind}`} style={style}>{inner}</span>;
      })}
    </div>
  );
}

/* ---------- canvas component ---------- */

export interface WorldMapCanvasProps {
  layout: WorldLayout;
  /** Highest unlocked level id: the road is glazed gold up to it. */
  progressLevelId: number;
}

export function WorldMapCanvas({ layout, progressLevelId }: WorldMapCanvasProps): ReactElement {
  const { width: W, height: H, bands, road } = layout;

  const scene = useMemo(() => {
    const signRects: Rect[] = layout.signs.map((s) => ({ l: s.x, t: s.y - 62, r: s.x + s.width, b: s.y + 70 }));
    const { gate } = layout;
    signRects.push({ l: gate.x - 190, t: gate.y - 250, r: gate.x + 190, b: gate.y + 140 });
    buildSprites(layout, [])
      .filter((s) => s.kind === 'fall')
      .forEach((s) => signRects.push({ l: s.x - 40, t: s.y - 30, r: s.x + s.w + 40, b: s.y + s.h + 60 }));
    const props = scatterProps(layout, signRects);
    const sprites = buildSprites(layout, props);
    const rows = bands.map((band, i) =>
      band.biome === 'frosting'
        ? { band, mountains: mountainRows(band, W, 404 + i * 13), hills: hillRows(band, bands[i - 1], W, 9001 + i * 17) }
        : { band, mountains: null, hills: hillRows(band, bands[i - 1], W, 9001 + i * 17) }
    );
    return { props, sprites, rows };
  }, [layout, bands, W]);

  const roadD = useMemo(() => smoothPath(road), [road]);
  // road[0] is the entry; road[k] is level k's node. Glaze through the current level.
  const progressIdx = Math.max(0, layout.nodes.findIndex((n) => n.levelId === progressLevelId));
  const progressD = useMemo(() => smoothPath(road, progressIdx + 1), [road, progressIdx]);

  const skyStops = useMemo(() => {
    const stops: Array<{ o: number; c: string }> = [];
    bands.forEach((b) => {
      const art = ART[b.biome];
      stops.push({ o: Math.max(0, (b.top + 80) / H), c: art.sky[0] });
      stops.push({ o: Math.min(1, (b.bottom - 80) / H), c: art.sky[1] });
    });
    return stops;
  }, [bands, H]);

  return (
    <div className="world-canvas" style={{ height: H }} aria-hidden="true">
      <svg className="world-canvas__svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="wm-sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            {skyStops.map((s, i) => (
              <stop key={i} offset={s.o} stopColor={s.c} />
            ))}
          </linearGradient>
          <radialGradient id="wm-orb" cx="0.34" cy="0.26" r="0.85">
            <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#3b0a1e" stopOpacity="0.28" />
          </radialGradient>
          <radialGradient id="wm-canopy" cx="0.35" cy="0.25" r="0.9">
            <stop offset="0" stopColor="#fff6c8" stopOpacity="0.45" />
            <stop offset="0.5" stopColor="#fff6c8" stopOpacity="0" />
            <stop offset="1" stopColor="#2f4a10" stopOpacity="0.3" />
          </radialGradient>
          <radialGradient id="wm-jelly" cx="0.4" cy="0.35" r="0.8">
            <stop offset="0" stopColor="#ff9cc4" />
            <stop offset="0.55" stopColor="#e24f8f" />
            <stop offset="1" stopColor="#a8296a" />
          </radialGradient>
          <linearGradient id="wm-mtn-shade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.25" />
            <stop offset="1" stopColor="#3a3a8a" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="wm-gold-glaze" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            <stop offset="0" stopColor="#ffd860" />
            <stop offset="0.5" stopColor="#ffbf3a" />
            <stop offset="1" stopColor="#ffd860" />
          </linearGradient>
          {scene.rows.flatMap(({ hills }) =>
            hills.map((row) => (
              <linearGradient key={row.key} id={`wm-h-${row.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={row.light} />
                <stop offset="0.5" stopColor={row.base} />
                <stop offset="1" stopColor={row.base} stopOpacity="0.85" />
              </linearGradient>
            ))
          )}
        </defs>

        <rect x="0" y="0" width={W} height={H} fill="url(#wm-sky)" />

        {scene.rows.map(({ band, hills, mountains }) => (
          <g key={band.chapterIndex} className={`wm-band wm-band--${band.biome}`}>
            {hills.map((row, i) => (
              <g key={row.key}>
                {mountains && mountains[i] ? (
                  <g>
                    {mountains[i].map((m) => (
                      <g key={m.key}>
                        <path d={m.body} fill={m.fill} />
                        <path d={m.body} fill="url(#wm-mtn-shade)" />
                        <path d={m.facet} fill="#5a5ab0" opacity="0.12" />
                        <path d={m.cap} fill="#ffffff" />
                        <path d={m.cap} fill="none" stroke="#e8eaff" strokeWidth="2" />
                      </g>
                    ))}
                  </g>
                ) : null}
                <g transform={mountains ? 'translate(0 70)' : undefined}>
                  <path d={row.d} fill={`url(#wm-h-${row.key})`} />
                  <path d={row.edge} fill="none" stroke={row.sheen} strokeOpacity={row.sheenOpacity} strokeWidth="3.5" strokeLinecap="round" transform="translate(0 4)" />
                </g>
              </g>
            ))}
          </g>
        ))}

        {/* The glazed cobblestone road */}
        <g className="wm-road">
          <path d={roadD} fill="none" stroke="rgba(70,32,18,0.22)" strokeWidth="70" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 12)" />
          <path d={roadD} fill="none" stroke="#a8693f" strokeWidth="62" strokeLinecap="round" strokeLinejoin="round" />
          <path d={roadD} fill="none" stroke="#d9965e" strokeWidth="54" strokeLinecap="round" strokeLinejoin="round" />
          <path d={roadD} fill="none" stroke="#f6c58f" strokeWidth="48" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 -2)" />
          <path d={roadD} fill="none" stroke="#fff3e2" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
          <path d={progressD} fill="none" stroke="url(#wm-gold-glaze)" strokeOpacity="0.55" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
          <path d={roadD} fill="none" stroke="#ecd0ab" strokeOpacity="0.5" strokeWidth="16" strokeLinecap="round" strokeDasharray="5 21" />
          <path d={roadD} fill="none" stroke="#fff" strokeOpacity="0.75" strokeWidth="3" strokeLinecap="round" transform="translate(-9 -9)" />
          <path d={progressD} fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeDasharray="0.1 18" />
        </g>

        {scene.props.map((p, i) => (
          <PropArt key={i} p={p} shadow={ART[biomeAtY(bands, p.y)].shadow} />
        ))}

        <PalaceGate x={layout.gate.x} y={layout.gate.y} />
      </svg>
      <SpriteLayer sprites={scene.sprites} />
    </div>
  );
}

function biomeAtY(bands: WorldBand[], y: number): BiomeKind {
  for (const b of bands) if (y >= b.top && y < b.bottom) return b.biome;
  return bands[bands.length - 1]?.biome ?? 'meadow';
}

function PalaceGate({ x, y }: Pt): ReactElement {
  return (
    <g transform={`translate(${r1(x)} ${r1(y + 30)})`}>
      <ellipse cx="0" cy="4" rx="150" ry="22" fill="rgba(20,6,12,0.35)" />
      {[-96, 96].map((tx) => (
        <g key={tx} transform={`translate(${tx} 0)`}>
          <rect x="-30" y="-150" width="60" height="150" rx="8" fill="#5a2e22" />
          <rect x="-30" y="-150" width="20" height="150" fill="#6e3a2a" />
          <path d="M-36 -150 L0 -224 L36 -150 Z" fill="#7a2846" />
          <path d="M0 -224 L36 -150 H10 Z" fill="#000" opacity="0.2" />
          <circle cx="0" cy="-230" r="7" fill="#ffd25e" />
          <path d="M-9 -80 V-96 A9 9 0 0 1 9 -96 V-80 Z" fill="#ffcf6a" />
        </g>
      ))}
      <path d="M-66 0 V-92 A66 66 0 0 1 66 -92 V0 H40 V-86 A40 40 0 0 0 -40 -86 V0 Z" fill="#6e3a2a" />
      <path d="M-66 -92 A66 66 0 0 1 66 -92" fill="none" stroke="#c07a3a" strokeWidth="8" />
      <path d="M-40 0 V-86 A40 40 0 0 1 40 -86 V0 Z" fill="#ffcf6a" opacity="0.9" />
      <path d="M-40 0 V-86 A40 40 0 0 1 40 -86 V0 Z" fill="url(#wm-orb)" />
      <path d="M0 -168 l6 -12 l6 12 l-6 6 z" fill="#ffd25e" transform="translate(-6 0)" />
    </g>
  );
}

/* ---------- ambient particles ---------- */

export interface WorldParticlesProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  bands: WorldBand[];
  reducedMotion: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  age: number;
  kind: BiomeKind;
}

export function WorldParticles({ scrollRef, bands, reducedMotion }: WorldParticlesProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    if (reducedMotion) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);

    const particles: Particle[] = [];
    const count = () => Math.max(26, Math.min(72, Math.round((w * h) / 20000)));
    const scrollTop = () => scrollRef.current?.scrollTop ?? 0;

    const spawn = (p: Particle | null, fromTop: boolean): Particle => {
      const y = fromTop ? -10 : Math.random() * h;
      const kind = biomeAtY(bandsRef.current, scrollTop() + y);
      const base: Particle = p ?? { x: 0, y: 0, vx: 0, vy: 0, r: 0, phase: 0, age: 0, kind };
      base.kind = kind;
      base.x = Math.random() * w;
      base.y = y;
      base.age = 0;
      base.phase = Math.random() * Math.PI * 2;
      switch (kind) {
        case 'meadow':
          base.r = 3 + Math.random() * 4;
          base.vx = (Math.random() - 0.5) * 6;
          base.vy = -4 - Math.random() * 6;
          break;
        case 'jelly':
          base.r = 3 + Math.random() * 6;
          base.vx = (Math.random() - 0.5) * 8;
          base.vy = -12 - Math.random() * 14;
          break;
        case 'frosting':
          base.r = 1.6 + Math.random() * 3.2;
          base.vx = (Math.random() - 0.5) * 10;
          base.vy = 18 + Math.random() * 26;
          break;
        case 'orchard':
          base.r = 2.5 + Math.random() * 4;
          base.vx = 4 + Math.random() * 8;
          base.vy = -3 - Math.random() * 5;
          break;
        case 'palace':
          base.r = 2 + Math.random() * 3.5;
          base.vx = (Math.random() - 0.5) * 3;
          base.vy = -2 - Math.random() * 3;
          break;
      }
      return base;
    };

    let lastScroll = scrollTop();
    let last = performance.now();
    let raf = 0;

    const star = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r * 2);
      ctx.quadraticCurveTo(x, y, x + r * 2, y);
      ctx.quadraticCurveTo(x, y, x, y + r * 2);
      ctx.quadraticCurveTo(x, y, x - r * 2, y);
      ctx.quadraticCurveTo(x, y, x, y - r * 2);
      ctx.fill();
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = scrollTop();
      const dScroll = st - lastScroll;
      lastScroll = st;
      const want = count();
      while (particles.length < want) particles.push(spawn(null, false));
      if (particles.length > want) particles.length = want;

      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.age += dt;
        p.phase += dt * 2.2;
        p.y -= dScroll;
        p.x += (p.vx + Math.sin(p.phase) * (p.kind === 'frosting' ? 14 : 5)) * dt;
        p.y += p.vy * dt;
        const outBottom = p.y > h + 20;
        const outTop = p.y < -20;
        if (outBottom || outTop || p.x < -20 || p.x > w + 20 || p.age > 14) {
          spawn(p, p.kind === 'frosting' && outBottom);
          continue;
        }
        const fade = Math.min(1, p.age / 0.8) * Math.min(1, (14 - p.age) / 1.2);
        switch (p.kind) {
          case 'meadow': {
            const tw = 0.45 + 0.55 * Math.abs(Math.sin(p.phase * 1.3));
            ctx.globalAlpha = fade * tw * 0.9;
            ctx.fillStyle = '#ffffff';
            star(p.x, p.y, p.r * 0.75);
            ctx.globalAlpha = fade * tw * 0.35;
            ctx.fillStyle = '#ffd860';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 0.9, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'jelly': {
            ctx.globalAlpha = fade * 0.55;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.4;
            ctx.fillStyle = 'rgba(255, 140, 190, 0.28)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.globalAlpha = fade * 0.85;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.28, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'frosting': {
            ctx.globalAlpha = fade * 0.9;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = fade * 0.25;
            ctx.fillStyle = '#9aa2ff';
            ctx.beginPath();
            ctx.arc(p.x + 0.6, p.y + 0.8, p.r, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'orchard': {
            const glow = 0.5 + 0.5 * Math.sin(p.phase);
            ctx.globalAlpha = fade * (0.18 + glow * 0.14);
            ctx.fillStyle = '#ffcf5a';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = fade * (0.6 + glow * 0.3);
            ctx.fillStyle = '#fff3c4';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 0.8, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          case 'palace': {
            const tw = Math.max(0, Math.sin(p.phase * 1.6));
            ctx.globalAlpha = fade * (0.25 + tw * 0.75);
            ctx.fillStyle = '#ffd25e';
            star(p.x, p.y, p.r * (0.7 + tw * 0.4));
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [reducedMotion, scrollRef]);

  return <canvas ref={canvasRef} className="world-particles" aria-hidden="true" />;
}
