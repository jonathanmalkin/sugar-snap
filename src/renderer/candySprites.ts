/**
 * Sugar Snap — candy sprite atlas.
 *
 * Candies, specials, ingredients, blockers and jelly are rendered per pixel by
 * the studio-lit PBR baker (pbrCandyBaker.ts) into offscreen canvases at
 * pbrBakeSize(cellSize, dpr) device pixels, then blitted every frame. Each
 * candy also gets a "sheen" layer the board uses for its moving glass glint.
 *
 * Baking is split so the first frame never waits on sprites it does not show:
 * prewarm() bakes the level's plain candies at once and queues everything else
 * (stripes, wrapped, bomb, then the Sugar Bee seekers);
 * bakeIdle() drains that queue a few milliseconds per frame. Any sprite asked
 * for before its turn is simply baked on demand.
 *
 * Colourblind badges and soft glows stay as tiny Canvas 2D paints.
 */
import type { Candy, CandyColor, IngredientType } from '../engine/types';
import { bakePbrSprite, pbrBakeSize, releasePbrMemo, type PbrSpriteSpec } from './pbrCandyBaker';

type Ctx = CanvasRenderingContext2D;

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
    light: '#c9ecff',
    base: '#2f8cff',
    mid: '#1560ea',
    dark: '#0a3cb0',
    deep: '#03185a',
    glow: '#8fe4ff',
    rim: '#d4f4ff',
    particle: '#3a9bff',
  },
  purple: {
    light: '#f3dcff',
    base: '#c06dff',
    mid: '#a044f5',
    dark: '#6418ad',
    deep: '#2d0457',
    glow: '#ecbfff',
    rim: '#f8e6ff',
    particle: '#c072ff',
  },
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

/* -------------------------------------------------------------------------- */
/* Canvas 2D overlays: colourblind badges, glows                               */
/* -------------------------------------------------------------------------- */

function badgePath(color: CandyColor, S: number): { path: Path2D; ring: boolean } {
  const cx = S * 0.5;
  const cy = S * 0.5;
  const r = S * 0.13;
  const p = new Path2D();
  // Each glyph echoes its candy's silhouette: heart (cherry bean), tilted oval
  // (tangerine lozenge), droplet (lemon drop), rounded square (lime pillow),
  // ring (blueberry drop) and a three-berry cluster (grape bonbon).
  switch (color) {
    case 'red': // heart
      p.moveTo(cx, cy + r * 1.05);
      p.bezierCurveTo(cx - r * 1.35, cy + r * 0.1, cx - r * 1.05, cy - r * 1.1, cx, cy - r * 0.45);
      p.bezierCurveTo(cx + r * 1.05, cy - r * 1.1, cx + r * 1.35, cy + r * 0.1, cx, cy + r * 1.05);
      p.closePath();
      return { path: p, ring: false };
    case 'orange': // tilted oval
      p.ellipse(cx, cy, r * 1.15, r * 0.78, -0.31, 0, Math.PI * 2);
      return { path: p, ring: false };
    case 'yellow': // droplet
      p.moveTo(cx, cy - r * 1.25);
      p.bezierCurveTo(cx + r * 0.3, cy - r * 0.6, cx + r, cy - r * 0.05, cx + r, cy + r * 0.3);
      p.arc(cx, cy + r * 0.3, r, 0, Math.PI);
      p.bezierCurveTo(cx - r, cy - r * 0.05, cx - r * 0.3, cy - r * 0.6, cx, cy - r * 1.25);
      p.closePath();
      return { path: p, ring: false };
    case 'green':
      roundRectPath(p, cx - r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8, r * 0.45);
      return { path: p, ring: false };
    case 'blue':
      p.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      return { path: p, ring: true };
    case 'purple': {
      // Three berries in a triangle.
      const br = r * 0.56;
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
        const bx = cx + Math.cos(a) * r * 0.58;
        const by = cy + Math.sin(a) * r * 0.58;
        p.moveTo(bx + br, by);
        p.arc(bx, by, br, 0, Math.PI * 2);
      }
      return { path: p, ring: false };
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

function candySpec(candy: Candy): PbrSpriteSpec {
  if (candy.ingredient) return { kind: candy.ingredient };
  if (candy.special === 'color-bomb') return { kind: 'bomb' };
  return { kind: 'candy', color: candy.color, special: candy.special };
}

function blockerSpec(kind: BlockerSpriteKind): PbrSpriteSpec {
  switch (kind) {
    case 'frosting-1':
      return { kind: 'frosting', layers: 1 };
    case 'frosting-2':
      return { kind: 'frosting', layers: 2 };
    case 'frosting-3':
      return { kind: 'frosting', layers: 3 };
    case 'locked':
      return { kind: 'locked' };
    case 'chocolate':
      return { kind: 'chocolate' };
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function pixelsToCanvas(pixels: Uint8ClampedArray, S: number): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(S);
  const img = ctx.createImageData(S, S);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const ALL_COLORS: readonly CandyColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** Maps internal atlas keys to pre-rendered studio-3D transparent PNGs in public/sprites/. */
const SPRITE_FILES: Record<string, string> = {
  'red:none': 'candy-red.png',
  'orange:none': 'candy-orange.png',
  'yellow:none': 'candy-yellow.png',
  'green:none': 'candy-green.png',
  'blue:none': 'candy-blue.png',
  'purple:none': 'candy-purple.png',
  'red:striped-h': 'striped-h-red.png',
  'orange:striped-h': 'striped-h-orange.png',
  'yellow:striped-h': 'striped-h-yellow.png',
  'green:striped-h': 'striped-h-green.png',
  'blue:striped-h': 'striped-h-blue.png',
  'purple:striped-h': 'striped-h-purple.png',
  'red:striped-v': 'striped-v-red.png',
  'orange:striped-v': 'striped-v-orange.png',
  'yellow:striped-v': 'striped-v-yellow.png',
  'green:striped-v': 'striped-v-green.png',
  'blue:striped-v': 'striped-v-blue.png',
  'purple:striped-v': 'striped-v-purple.png',
  'red:wrapped': 'wrapped-red.png',
  'orange:wrapped': 'wrapped-orange.png',
  'yellow:wrapped': 'wrapped-yellow.png',
  'green:wrapped': 'wrapped-green.png',
  'blue:wrapped': 'wrapped-blue.png',
  'purple:wrapped': 'wrapped-purple.png',
  'red:seeker': 'fish-red.png',
  'orange:seeker': 'fish-orange.png',
  'yellow:seeker': 'fish-yellow.png',
  'green:seeker': 'fish-green.png',
  'blue:seeker': 'fish-blue.png',
  'purple:seeker': 'fish-purple.png',
  bomb: 'color-bomb.png',
  'ing:cherry': 'donut.png',
  'ing:hazelnut': 'donut.png',
  'blk:frosting-1': 'frosting-1.png',
  'blk:frosting-2': 'frosting-2.png',
  'blk:frosting-3': 'frosting-3.png',
  'blk:chocolate': 'chocolate.png',
  'blk:locked': 'lock-overlay.png',
  'jelly:1': 'jelly-1.png',
  'jelly:2': 'jelly-1.png',
  'exit-arrow': 'exit-arrow.png',
};

const UNIQUE_SPRITE_FILENAMES: readonly string[] = Array.from(new Set(Object.values(SPRITE_FILES)));

export function getSpriteUrl(filename: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  return `${base.endsWith('/') ? base : `${base}/`}sprites/${filename}`;
}

interface ImageEntry {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
}

const imageRegistry = new Map<string, ImageEntry>();
const spriteLoadListeners = new Set<(filename: string) => void>();

function ensureImage(filename: string): ImageEntry | null {
  if (typeof Image === 'undefined') return null;
  let entry = imageRegistry.get(filename);
  if (entry) return entry;
  const img = new Image();
  img.decoding = 'async';
  entry = { img, loaded: false, failed: false };
  imageRegistry.set(filename, entry);
  img.onload = () => {
    entry!.loaded = true;
    for (const cb of spriteLoadListeners) cb(filename);
  };
  img.onerror = () => {
    entry!.failed = true;
  };
  img.src = getSpriteUrl(filename);
  if (img.complete && img.naturalWidth > 0) entry.loaded = true;
  return entry;
}

export function getLoadedSpriteImage(filename: string): HTMLImageElement | null {
  const entry = ensureImage(filename);
  if (entry && entry.loaded && entry.img.naturalWidth > 0) return entry.img;
  return null;
}

export function preloadAllSpriteImages(): void {
  if (typeof Image === 'undefined') return;
  for (const fn of UNIQUE_SPRITE_FILENAMES) ensureImage(fn);
}

export class CandySpriteAtlas {
  private cache = new Map<string, HTMLCanvasElement>();
  private fromPng = new Set<string>();
  private sheens = new Map<string, HTMLCanvasElement | null>();
  private queue: Array<[string, PbrSpriteSpec]> = [];
  private px = 0;
  private dpr = 1;
  private cell = 0;
  private bakeMs = 0;
  private colors: readonly CandyColor[] = ALL_COLORS;
  private readonly onImgLoad: (filename: string) => void;

  constructor(cellSize = 64, dpr = 1) {
    this.onImgLoad = (filename: string) => {
      // Upgrade any fallback sprite cached before this PNG finished decoding.
      for (const [key, fn] of Object.entries(SPRITE_FILES)) {
        if (fn === filename && !this.fromPng.has(key)) {
          this.cache.delete(key);
          this.sheens.delete(key);
        }
      }
    };
    spriteLoadListeners.add(this.onImgLoad);
    preloadAllSpriteImages();
    this.ensure(cellSize, dpr);
  }

  /** Re-bakes lazily when the device-pixel sprite size changes. Returns true if the cache was flushed. */
  ensure(cellSize: number, dpr: number): boolean {
    const px = pbrBakeSize(cellSize, dpr);
    this.cell = cellSize;
    if (px === this.px && dpr === this.dpr) return false;
    const hadSprites = this.cache.size > 0;
    this.px = px;
    this.dpr = dpr;
    this.flush();
    // Re-queue everything for the new size so idle frames rebuild it.
    if (hadSprites) this.enqueueAll(this.colors);
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

  /** Milliseconds spent in PBR bakes since the last flush. */
  get bakeTimeMs(): number {
    return this.bakeMs;
  }

  /** Sprites still waiting for an idle bake. */
  get pendingBakes(): number {
    return this.queue.length;
  }

  clear(): void {
    this.flush();
    spriteLoadListeners.delete(this.onImgLoad);
  }

  private flush(): void {
    this.cache.clear();
    this.fromPng.clear();
    this.sheens.clear();
    this.queue.length = 0;
    this.bakeMs = 0;
    releasePbrMemo();
  }

  /**
   * Starts parallel PNG decoding for all studio-3D sprites and warms colorblind badges.
   */
  prewarm(colors: readonly CandyColor[] = ALL_COLORS): void {
    this.colors = colors.length ? colors : ALL_COLORS;
    preloadAllSpriteImages();
    for (const color of this.colors) {
      this.getCandy({ id: -1, color, special: 'none' });
      this.getColorblindBadge(color);
    }
    this.enqueueAll(this.colors);
  }

  private enqueueAll(colors: readonly CandyColor[]): void {
    const add = (key: string, spec: PbrSpriteSpec) => {
      if (this.fromPng.has(key)) return;
      const fn = SPRITE_FILES[key];
      if (fn && getLoadedSpriteImage(fn)) {
        this.bakeFromPng(key, getLoadedSpriteImage(fn)!);
        return;
      }
      if (!this.cache.has(key) && !this.queue.some((q) => q[0] === key)) this.queue.push([key, spec]);
    };
    for (const color of colors) add(`${color}:none`, { kind: 'candy', color, special: 'none' });
    add('jelly:1', { kind: 'jelly', layers: 1 });
    add('blk:frosting-1', blockerSpec('frosting-1'));
    add('blk:frosting-2', blockerSpec('frosting-2'));
    add('blk:frosting-3', blockerSpec('frosting-3'));
    add('blk:chocolate', blockerSpec('chocolate'));
    add('blk:locked', blockerSpec('locked'));
    add('ing:cherry', { kind: 'cherry' });
    for (const color of colors) {
      for (const special of ['striped-h', 'striped-v', 'wrapped'] as const) add(`${color}:${special}`, { kind: 'candy', color, special });
    }
    add('bomb', { kind: 'bomb' });
    for (const color of colors) add(`${color}:seeker`, { kind: 'candy', color, special: 'seeker' });
  }

  /**
   * Drains queued fallback bakes if PNGs have not yet loaded.
   */
  bakeIdle(budgetMs = 4): boolean {
    if (this.queue.length === 0) return false;
    const t0 = now();
    while (this.queue.length > 0) {
      const [key, spec] = this.queue.shift()!;
      this.bakePbr(key, spec);
      if (now() - t0 >= budgetMs) break;
    }
    if (this.queue.length === 0) releasePbrMemo();
    return this.queue.length > 0;
  }

  getCandy(candy: Candy): HTMLCanvasElement {
    if (candy.ingredient) return this.getIngredient(candy.ingredient);
    return this.bakePbr(candySpriteKey(candy), candySpec(candy));
  }

  /** Additive glint layer for a candy (null for studio-3D PNG sprites which carry real baked highlights). */
  getCandySheen(candy: Candy): HTMLCanvasElement | null {
    const key = candySpriteKey(candy);
    if (this.fromPng.has(key)) return null;
    if (!this.sheens.has(key)) this.getCandy(candy);
    return this.sheens.get(key) ?? null;
  }

  getIngredient(type: IngredientType): HTMLCanvasElement {
    return this.bakePbr(`ing:${type}`, { kind: type });
  }

  getBlocker(kind: BlockerSpriteKind): HTMLCanvasElement {
    return this.bakePbr(`blk:${kind}`, blockerSpec(kind));
  }

  getFrosting(layers: 1 | 2 | 3): HTMLCanvasElement {
    return this.getBlocker(`frosting-${layers}` as BlockerSpriteKind);
  }

  getJelly(layers: 1 | 2): HTMLCanvasElement {
    return this.bakePbr(`jelly:${layers}`, { kind: 'jelly', layers: 1 });
  }

  getExitArrow(): HTMLCanvasElement | null {
    const hit = this.cache.get('exit-arrow');
    if (hit && this.fromPng.has('exit-arrow')) return hit;
    const img = getLoadedSpriteImage('exit-arrow.png');
    if (!img) return null;
    return this.bakeFromPng('exit-arrow', img);
  }

  getColorblindBadge(color: CandyColor): HTMLCanvasElement {
    return this.bake(`badge:${color}`, (ctx, S) => drawBadge(ctx, S, color));
  }

  /** Soft radial glow sprite (halos, auras, comet heads). */
  getGlow(color: string): HTMLCanvasElement {
    return this.bake(`glow:${color}`, (ctx, S) => drawGlow(ctx, S, color));
  }

  private bakeFromPng(key: string, img: HTMLImageElement): HTMLCanvasElement {
    const [canvas, ctx] = makeCanvas(this.px);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Slightly oversize blockers/jelly/locks so tiles sit flush; candies keep natural padding.
    const fullBleed = key.startsWith('jelly:') || key === 'blk:locked' || key.startsWith('blk:frosting-') || key === 'blk:chocolate';
    const inset = fullBleed ? this.px * 0.015 : 0;
    ctx.drawImage(img, inset, inset, this.px - inset * 2, this.px - inset * 2);
    this.cache.set(key, canvas);
    this.fromPng.add(key);
    this.sheens.set(key, null);
    return canvas;
  }

  private bakePbr(key: string, spec: PbrSpriteSpec): HTMLCanvasElement {
    const fn = SPRITE_FILES[key];
    if (fn) {
      const img = getLoadedSpriteImage(fn);
      if (img) {
        const hit = this.cache.get(key);
        if (hit && this.fromPng.has(key)) return hit;
        return this.bakeFromPng(key, img);
      }
    }
    const hit = this.cache.get(key);
    if (hit) return hit;
    const t0 = now();
    const res = bakePbrSprite(spec, this.px);
    const canvas = pixelsToCanvas(res.pixels, res.size);
    this.cache.set(key, canvas);
    this.sheens.set(key, res.sheen ? pixelsToCanvas(res.sheen, res.size) : null);
    this.bakeMs += now() - t0;
    return canvas;
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
