/**
 * Sugar Snap — pooled particle & VFX system.
 *
 * All coordinates are CSS pixels in canvas space. Call update(dt) once per
 * frame and draw(ctx, viewW, viewH) after the board has been painted.
 */
import { makeCanvas, withAlpha } from './candySprites';

type Ctx = CanvasRenderingContext2D;

export const FONT_STACK = '"Baloo 2", "Fredoka", "Nunito", ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif';

interface Droplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  color: string;
  gravity: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  max: number;
  color: string;
  rot: number;
  spin: number;
  twinkle: number;
}

/** Crystalline sugar shard that tumbles in 3D and flashes when a facet faces the light. */
interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  max: number;
  color: string;
  rot: number;
  spin: number;
  flip: number;
  flipSpeed: number;
  gravity: number;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  max: number;
  color: string;
  width: number;
}

interface Beam {
  ox: number;
  oy: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  life: number;
  max: number;
  color: string;
  thickness: number;
}

interface Bolt {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  max: number;
  color: string | 'rainbow';
  hue: number;
  points: Array<[number, number][]>;
  regen: number;
}

interface Comet {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  t: number;
  dur: number;
  delay: number;
  color: string;
  trail: Array<[number, number]>;
  onArrive?: () => void;
  arrived: boolean;
}

/** Payload a homing Sugar Bee carries to its target. */
export type SeekerPayload = 'none' | 'striped-h' | 'striped-v' | 'wrapped';

/** A glossy Sugar Bee swooping along a cubic Bézier toward its target. */
interface BeeFlight {
  x0: number;
  y0: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  delay: number;
  color: string;
  size: number;
  payload: SeekerPayload;
  wing: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  pollen: number;
  trail: Array<[number, number]>;
  arrived: boolean;
  linger: number;
  onArrive?: () => void;
}

/** Radiating starburst rays (bee impact). */
interface Starburst {
  x: number;
  y: number;
  r: number;
  rays: number;
  rot: number;
  life: number;
  max: number;
  color: string;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface Banner {
  text: string;
  x: number;
  y: number;
  life: number;
  max: number;
  scale: number;
  vel: number;
  size: number;
  big: boolean;
}

const MAX_DROPS = 700;
const MAX_SPARKS = 500;
const MAX_SHARDS = 260;
const MAX_BEES = 48;
const GOLD_POLLEN = '#ffd45c';
const BEE_FLIGHT_DUR = 0.34;

/** Seconds a Sugar Bee takes from (x0,y0) to (x1,y1): ~340ms, a touch longer on long hauls. */
export function seekerFlightDuration(x0: number, y0: number, x1: number, y1: number, size: number): number {
  const len = Math.hypot(x1 - x0, y1 - y0);
  return BEE_FLIGHT_DUR * (0.92 + Math.min(0.35, len / Math.max(1, size * 18)));
}

const easeBee = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Honey stripe that always contrasts with the bee's body colour. */
function beeStripeColor(body: string): string {
  const [r, g, b] = hexRgb(body);
  const yellowish = r > 200 && g > 170 && b < 140;
  return yellowish ? '#6b3108' : luminance(body) > 0.62 ? '#b86a00' : '#ffc23a';
}

function hexRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes a hex colour toward another, returned as an rgba() string. */
function mix(hex: string, toward: string, t: number, a = 1): string {
  const [r1, g1, b1] = hexRgb(hex);
  const [r2, g2, b2] = hexRgb(toward);
  return `rgba(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)},${a})`;
}

export class ParticleSystem {
  private drops: Droplet[] = [];
  private dropCount = 0;
  private sparks: Spark[] = [];
  private sparkCount = 0;
  private shards: Shard[] = [];
  private shardCount = 0;
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private bolts: Bolt[] = [];
  private comets: Comet[] = [];
  private bees: BeeFlight[] = [];
  private starbursts: Starburst[] = [];
  private popups: Popup[] = [];
  private banners: Banner[] = [];
  private flashAlpha = 0;
  private flashColor = '#ffffff';
  private shakeAmp = 0;
  private shakeX = 0;
  private shakeY = 0;
  private time = 0;
  private reducedMotion = false;
  private spriteCache = new Map<string, HTMLCanvasElement>();
  private spriteScale = 2;

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    if (value) this.shakeAmp = 0;
  }

  /** Sprite resolution multiplier (pass the device pixel ratio). */
  setPixelRatio(dpr: number): void {
    const s = Math.max(1, Math.min(3, Math.ceil(dpr)));
    if (s !== this.spriteScale) {
      this.spriteScale = s;
      this.spriteCache.clear();
    }
  }

  get isBusy(): boolean {
    return (
      this.dropCount +
        this.sparkCount +
        this.shardCount +
        this.rings.length +
        this.beams.length +
        this.bolts.length +
        this.comets.length +
        this.bees.length +
        this.starbursts.length +
        this.popups.length +
        this.banners.length >
      0
    );
  }

  clear(): void {
    this.dropCount = 0;
    this.sparkCount = 0;
    this.shardCount = 0;
    this.rings.length = 0;
    this.beams.length = 0;
    this.bolts.length = 0;
    this.comets.length = 0;
    this.bees.length = 0;
    this.starbursts.length = 0;
    this.popups.length = 0;
    this.banners.length = 0;
    this.flashAlpha = 0;
    this.shakeAmp = 0;
  }

  /* ------------------------------ emitters ------------------------------ */

  private density(n: number): number {
    return Math.max(1, Math.round(this.reducedMotion ? n * 0.5 : n));
  }

  private allocDrop(): Droplet | null {
    if (this.dropCount >= MAX_DROPS) return null;
    let d = this.drops[this.dropCount];
    if (!d) {
      d = { x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, max: 1, color: '#fff', gravity: 0 };
      this.drops.push(d);
    }
    this.dropCount++;
    return d;
  }

  private allocSpark(): Spark | null {
    if (this.sparkCount >= MAX_SPARKS) return null;
    let s = this.sparks[this.sparkCount];
    if (!s) {
      s = { x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, max: 1, color: '#fff', rot: 0, spin: 0, twinkle: 0 };
      this.sparks.push(s);
    }
    this.sparkCount++;
    return s;
  }

  private allocShard(): Shard | null {
    if (this.shardCount >= MAX_SHARDS) return null;
    let s = this.shards[this.shardCount];
    if (!s) {
      s = { x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, max: 1, color: '#fff', rot: 0, spin: 0, flip: 0, flipSpeed: 0, gravity: 0 };
      this.shards.push(s);
    }
    this.shardCount++;
    return s;
  }

  /** Crystalline sugar shards that tumble and glint as they fall. */
  private shardBurst(x: number, y: number, color: string, count: number, power: number, cellSize: number): void {
    const n = this.density(count);
    for (let i = 0; i < n; i++) {
      const s = this.allocShard();
      if (!s) return;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 2.2) * cellSize * power;
      s.x = x + Math.cos(a) * cellSize * 0.1;
      s.y = y + Math.sin(a) * cellSize * 0.1;
      s.vx = Math.cos(a) * sp;
      s.vy = Math.sin(a) * sp - cellSize * (1.4 + Math.random() * 1.4);
      s.size = cellSize * (0.07 + Math.random() * 0.07);
      s.max = s.life = 0.5 + Math.random() * 0.45;
      s.color = color;
      s.rot = Math.random() * Math.PI * 2;
      s.spin = (Math.random() - 0.5) * 10;
      s.flip = Math.random() * Math.PI * 2;
      s.flipSpeed = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
      s.gravity = cellSize * 11;
    }
  }

  /** Glossy jelly droplets (plus a few sugar shards) bursting from a cleared candy. */
  jellyBurst(x: number, y: number, color: string, count = 10, power = 1, cellSize = 60): void {
    this.shardBurst(x, y, color, Math.max(1, Math.round(count * 0.4)), power, cellSize);
    const n = this.density(count);
    for (let i = 0; i < n; i++) {
      const d = this.allocDrop();
      if (!d) return;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.9 + Math.random() * 2.4) * cellSize * power;
      d.x = x + Math.cos(a) * cellSize * 0.12;
      d.y = y + Math.sin(a) * cellSize * 0.12;
      d.vx = Math.cos(a) * sp;
      d.vy = Math.sin(a) * sp - cellSize * (1.2 + Math.random() * 1.6);
      d.r = cellSize * (0.045 + Math.random() * 0.06);
      d.max = d.life = 0.45 + Math.random() * 0.4;
      d.color = color;
      d.gravity = cellSize * 14;
    }
  }

  /** Twinkling 4-point sugar sparkles. */
  sparkle(x: number, y: number, count = 6, color = '#ffffff', spread = 24, speed = 60): void {
    const n = this.density(count);
    for (let i = 0; i < n; i++) {
      const s = this.allocSpark();
      if (!s) return;
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * spread;
      const sp = speed * (0.3 + Math.random());
      s.x = x + Math.cos(a) * d;
      s.y = y + Math.sin(a) * d;
      s.vx = Math.cos(a) * sp;
      s.vy = Math.sin(a) * sp - speed * 0.3;
      s.size = 4 + Math.random() * 7;
      s.max = s.life = 0.45 + Math.random() * 0.5;
      s.color = color;
      s.rot = Math.random() * Math.PI;
      s.spin = (Math.random() - 0.5) * 6;
      s.twinkle = Math.random() * Math.PI * 2;
    }
  }

  /** Expanding translucent shockwave ring. */
  shockwave(x: number, y: number, radius: number, color = '#ffffff', width = 10, duration = 0.45): void {
    this.rings.push({ x, y, r0: radius * 0.15, r1: radius, life: duration, max: duration, color, width });
  }

  /**
   * Striped-candy laser beam. Grows from the origin out to both ends.
   * thickness should be ~0.3 * cellSize for width 1, ~0.9 * cellSize for width 3.
   */
  laser(ox: number, oy: number, ax: number, ay: number, bx: number, by: number, color: string, thickness: number, duration = 0.42): void {
    this.beams.push({ ox, oy, ax, ay, bx, by, life: duration, max: duration, color, thickness });
    const len = Math.hypot(bx - ax, by - ay);
    const n = this.density(Math.round(len / 28));
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      this.sparkle(ax + (bx - ax) * t, ay + (by - ay) * t, 1, i % 2 ? '#ffffff' : color, thickness * 0.6, 90);
    }
  }

  /** Branching jagged lightning (color bomb zap). Pass 'rainbow' for a hue-cycling arc. */
  lightning(x1: number, y1: number, x2: number, y2: number, color: string | 'rainbow' = 'rainbow', duration = 0.34): void {
    const bolt: Bolt = { x1, y1, x2, y2, life: duration, max: duration, color, hue: Math.random() * 360, points: [], regen: 0 };
    bolt.points = this.genBolt(x1, y1, x2, y2);
    this.bolts.push(bolt);
    this.sparkle(x2, y2, 3, '#ffffff', 10, 70);
  }

  /** Golden comet arcing from (x0,y0) to (x1,y1); onArrive fires on impact. */
  comet(x0: number, y0: number, x1: number, y1: number, color = '#ffd45c', duration = 0.55, delay = 0, onArrive?: () => void): void {
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const side = Math.random() < 0.5 ? -1 : 1;
    this.comets.push({
      x0,
      y0,
      x1,
      y1,
      cx: mx - dy * 0.35 * side,
      cy: my + dx * 0.35 * side - Math.abs(dx) * 0.1,
      t: 0,
      dur: duration,
      delay,
      color,
      trail: [],
      onArrive,
      arrived: false,
    });
  }

  /**
   * Homing Sugar Bee: a glossy candy bee with fluttering glass wings swoops from
   * (x0,y0) to (x1,y1) along a curved Bézier arc (~340ms), shedding a sparkling
   * golden pollen trail, then lands with a juicy starburst and splash.
   * `size` is the bee's body length (pass the cell size). onArrive fires on impact.
   */
  seekerFlight(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    size: number,
    payload: SeekerPayload = 'none',
    onArrive?: () => void,
    delay = 0,
  ): void {
    if (this.bees.length >= MAX_BEES) {
      // Never drop the gameplay callback, even when the swarm is capped.
      this.impact(x1, y1, color, size, payload);
      onArrive?.();
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const L = Math.max(len, size * 2.4);
    const nx = len > 0.001 ? -dy / len : 1;
    const ny = len > 0.001 ? dx / len : 0;
    // Swoop out to one side and up, then dive onto the target from the other.
    const side = Math.random() < 0.5 ? -1 : 1;
    const loft = this.reducedMotion ? 0.35 : 1;
    const c1x = x0 + dx * 0.12 + nx * side * L * 0.55 * loft;
    const c1y = y0 + dy * 0.12 + ny * side * L * 0.55 * loft - size * 1.5 * loft;
    const c2x = x0 + dx * 0.82 - nx * side * L * 0.22 * loft;
    const c2y = y0 + dy * 0.82 - ny * side * L * 0.22 * loft - size * 0.9 * loft;
    this.bees.push({
      x0,
      y0,
      c1x,
      c1y,
      c2x,
      c2y,
      x1,
      y1,
      t: 0,
      dur: seekerFlightDuration(x0, y0, x1, y1, size),
      delay: Math.max(0, delay),
      color,
      size,
      payload,
      wing: Math.random() * Math.PI * 2,
      x: x0,
      y: y0,
      heading: Math.atan2(c1y - y0, c1x - x0),
      speed: 0,
      pollen: 0,
      trail: [],
      arrived: false,
      linger: 0,
      onArrive,
    });
    // Launch puff.
    this.sparkle(x0, y0, 5, GOLD_POLLEN, size * 0.3, size * 1.4);
    this.shockwave(x0, y0, size * 0.75, color, 5, 0.28);
  }

  /** Bee landing: starburst rays, double ring, juicy splash and golden pollen. */
  private impact(x: number, y: number, color: string, size: number, payload: SeekerPayload): void {
    const big = payload !== 'none';
    this.starbursts.push({ x, y, r: size * (big ? 1.25 : 0.95), rays: big ? 12 : 9, rot: Math.random() * Math.PI, life: 0.3, max: 0.3, color });
    this.shockwave(x, y, size * (big ? 1.5 : 1.05), color, big ? 9 : 7, 0.38);
    this.shockwave(x, y, size * 0.6, '#ffffff', 5, 0.24);
    this.jellyBurst(x, y, color, big ? 12 : 8, 1.1, size);
    this.sparkle(x, y, big ? 12 : 8, GOLD_POLLEN, size * 0.4, size * 1.8);
    this.sparkle(x, y, 4, '#ffffff', size * 0.25, size * 1.2);
    this.flash(big ? 0.08 : 0.04, '#fff6d8');
  }

  /** Floating "+120" score popup. */
  scorePopup(x: number, y: number, points: number, color = '#ff4766', size = 22): void {
    const max = 0.95;
    this.popups.push({ x, y, text: `+${points.toLocaleString('en-US')}`, life: max, max, color, size: points >= 1000 ? size * 1.25 : size });
  }

  /** Spring-animated praise banner (Sweet!, Tasty!, Delicious!, Divine!, Sugar Crush!). */
  callout(text: string, x: number, y: number, size = 56, big = false): void {
    const max = big ? 1.8 : 1.3;
    this.banners.length = 0;
    this.banners.push({ text, x, y, life: max, max, scale: this.reducedMotion ? 1 : 0.15, vel: 0, size: big ? size * 1.15 : size, big });
  }

  flash(alpha: number, color = '#ffffff'): void {
    const a = this.reducedMotion ? alpha * 0.3 : alpha;
    if (a > this.flashAlpha) {
      this.flashAlpha = a;
      this.flashColor = color;
    }
  }

  shake(amount: number): void {
    const a = this.reducedMotion ? amount * 0.15 : amount;
    this.shakeAmp = Math.min(24, Math.max(this.shakeAmp, a));
  }

  getShakeOffset(): { x: number; y: number } {
    return { x: this.shakeX, y: this.shakeY };
  }

  /* ------------------------------- update ------------------------------- */

  update(dt: number): void {
    this.time += dt;

    for (let i = 0; i < this.dropCount; ) {
      const d = this.drops[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.dropCount--;
        this.drops[i] = this.drops[this.dropCount];
        this.drops[this.dropCount] = d;
        continue;
      }
      d.vy += d.gravity * dt;
      d.vx *= 1 - 1.6 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      i++;
    }

    for (let i = 0; i < this.sparkCount; ) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.sparkCount--;
        this.sparks[i] = this.sparks[this.sparkCount];
        this.sparks[this.sparkCount] = s;
        continue;
      }
      s.vx *= 1 - 2.5 * dt;
      s.vy = s.vy * (1 - 2.5 * dt) + 30 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
      i++;
    }

    for (let i = 0; i < this.shardCount; ) {
      const s = this.shards[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.shardCount--;
        this.shards[i] = this.shards[this.shardCount];
        this.shards[this.shardCount] = s;
        continue;
      }
      s.vy += s.gravity * dt;
      s.vx *= 1 - 1.4 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
      s.flip += s.flipSpeed * dt;
      i++;
    }

    this.rings =this.rings.filter((r) => (r.life -= dt) > 0);
    this.beams = this.beams.filter((b) => (b.life -= dt) > 0);
    this.popups = this.popups.filter((p) => (p.life -= dt) > 0);

    for (const b of this.bolts) {
      b.life -= dt;
      b.regen -= dt;
      if (b.regen <= 0) {
        b.points = this.genBolt(b.x1, b.y1, b.x2, b.y2);
        b.regen = 0.045;
      }
    }
    this.bolts = this.bolts.filter((b) => b.life > 0);

    for (const c of this.comets) {
      if (c.delay > 0) {
        c.delay -= dt;
        continue;
      }
      c.t += dt / c.dur;
      const p = this.cometPos(c, Math.min(1, c.t));
      c.trail.unshift(p);
      if (c.trail.length > 14) c.trail.length = 14;
      if (c.t >= 1 && !c.arrived) {
        c.arrived = true;
        this.sparkle(c.x1, c.y1, 8, c.color, 12, 120);
        this.shockwave(c.x1, c.y1, 40, c.color, 6, 0.35);
        c.onArrive?.();
      }
    }
    // Arrived comets linger briefly while their trail collapses into the target.
    this.comets = this.comets.filter((c) => !c.arrived || c.t < 1.25);

    for (const b of this.bees) {
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      if (b.arrived) {
        b.linger += dt;
        if (b.trail.length) b.trail.pop();
        continue;
      }
      b.t += dt / b.dur;
      const t = Math.min(1, b.t);
      const px = b.x;
      const py = b.y;
      const [x, y] = this.beePos(b, t);
      b.x = x;
      b.y = y;
      const vx = x - px;
      const vy = y - py;
      const v = Math.hypot(vx, vy);
      if (v > 0.01) {
        // Smoothly bank toward the direction of travel.
        const target = Math.atan2(vy, vx);
        let da = target - b.heading;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        b.heading += da * Math.min(1, dt * 26);
      }
      b.speed = dt > 0 ? v / dt : 0;
      b.wing += dt * (this.reducedMotion ? 22 : 58);
      b.trail.unshift([x, y]);
      if (b.trail.length > 16) b.trail.length = 16;
      // Golden pollen shed along the swoop.
      b.pollen += dt * (this.reducedMotion ? 45 : 110);
      while (b.pollen >= 1) {
        b.pollen -= 1;
        const d = this.allocDrop();
        if (d) {
          const a = Math.random() * Math.PI * 2;
          d.x = x + Math.cos(a) * b.size * 0.12;
          d.y = y + Math.sin(a) * b.size * 0.12;
          d.vx = -vx * 4 + Math.cos(a) * b.size * 0.6;
          d.vy = -vy * 4 + Math.sin(a) * b.size * 0.6 - b.size * 0.3;
          d.r = b.size * (0.025 + Math.random() * 0.03);
          d.max = d.life = 0.3 + Math.random() * 0.3;
          d.color = Math.random() < 0.7 ? GOLD_POLLEN : '#fff2b0';
          d.gravity = b.size * 3;
        }
        if (Math.random() < 0.45) this.sparkle(x, y, 1, Math.random() < 0.6 ? GOLD_POLLEN : b.color, b.size * 0.18, b.size * 0.5);
      }
      if (b.t >= 1) {
        b.arrived = true;
        this.impact(b.x1, b.y1, b.color, b.size, b.payload);
        b.onArrive?.();
      }
    }
    this.bees = this.bees.filter((b) => !b.arrived || b.linger < 0.12);
    this.starbursts = this.starbursts.filter((s) => (s.life -= dt) > 0);

    for (const b of this.banners) {
      b.life -= dt;
      if (this.reducedMotion) {
        b.scale = 1;
      } else {
        // Spring toward 1 with an overshoot.
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / steps;
        for (let k = 0; k < steps; k++) {
          const acc = -320 * (b.scale - 1) - 13 * b.vel;
          b.vel += acc * h;
          b.scale += b.vel * h;
        }
      }
    }
    this.banners = this.banners.filter((b) => b.life > 0);

    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 3.2);

    if (this.shakeAmp > 0.05) {
      const t = this.time * 60;
      this.shakeX = (Math.sin(t * 1.7) + Math.sin(t * 2.9) * 0.5) * this.shakeAmp * 0.66;
      this.shakeY = (Math.cos(t * 2.3) + Math.sin(t * 3.7) * 0.5) * this.shakeAmp * 0.66;
      this.shakeAmp *= Math.exp(-dt * 11);
    } else {
      this.shakeAmp = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  private beePos(b: BeeFlight, t: number): [number, number] {
    const e = easeBee(t);
    const u = 1 - e;
    const a = u * u * u;
    const bb = 3 * u * u * e;
    const c = 3 * u * e * e;
    const d = e * e * e;
    return [a * b.x0 + bb * b.c1x + c * b.c2x + d * b.x1, a * b.y0 + bb * b.c1y + c * b.c2y + d * b.y1];
  }

  private cometPos(c: Comet, t: number): [number, number] {
    // Ease-in-out on the bezier parameter for a satisfying swoop.
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const u = 1 - e;
    return [u * u * c.x0 + 2 * u * e * c.cx + e * e * c.x1, u * u * c.y0 + 2 * u * e * c.cy + e * e * c.y1];
  }

  private genBolt(x1: number, y1: number, x2: number, y2: number): Array<[number, number][]> {
    const main = this.jagged(x1, y1, x2, y2, 5, 0.2);
    const out: Array<[number, number][]> = [main];
    const branches = this.reducedMotion ? 1 : 2;
    for (let i = 0; i < branches; i++) {
      const idx = 2 + Math.floor(Math.random() * Math.max(1, main.length - 4));
      const [bx, by] = main[Math.min(idx, main.length - 1)];
      const ang = Math.atan2(y2 - y1, x2 - x1) + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.6);
      const len = Math.hypot(x2 - x1, y2 - y1) * (0.18 + Math.random() * 0.2);
      out.push(this.jagged(bx, by, bx + Math.cos(ang) * len, by + Math.sin(ang) * len, 3, 0.25));
    }
    return out;
  }

  private jagged(x1: number, y1: number, x2: number, y2: number, depth: number, rough: number): [number, number][] {
    let pts: [number, number][] = [
      [x1, y1],
      [x2, y2],
    ];
    let disp = Math.hypot(x2 - x1, y2 - y1) * rough;
    for (let d = 0; d < depth; d++) {
      const next: [number, number][] = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        const off = (Math.random() - 0.5) * disp;
        next.push([(ax + bx) / 2 + nx * off, (ay + by) / 2 + ny * off]);
        next.push(pts[i + 1]);
      }
      pts = next;
      disp *= 0.55;
    }
    return pts;
  }

  /* -------------------------------- draw -------------------------------- */

  private sprite(key: string, size: number, paint: (ctx: Ctx, S: number) => void): HTMLCanvasElement {
    const hit = this.spriteCache.get(key);
    if (hit) return hit;
    const S = Math.ceil(size * this.spriteScale);
    const [c, ctx] = makeCanvas(S);
    paint(ctx, S);
    this.spriteCache.set(key, c);
    return c;
  }

  /** Wet jelly droplet lit like the candies: deep rim, glowing core, mirror glints. */
  private dropSprite(color: string): HTMLCanvasElement {
    return this.sprite(`drop:${color}`, 40, (ctx, S) => {
      const c = S / 2;
      const r = S * 0.46;
      // Translucent body: lighter where light passes through, deeper toward the rim.
      const body = ctx.createRadialGradient(c - r * 0.22, c - r * 0.28, r * 0.05, c, c, r);
      body.addColorStop(0, mix(color, '#ffffff', 0.42));
      body.addColorStop(0.5, mix(color, '#ffffff', 0.05));
      body.addColorStop(0.86, mix(color, '#000000', 0.3));
      body.addColorStop(1, mix(color, '#000000', 0.45, 0.95));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-atop';
      // Subsurface glow exiting the lower right.
      const sss = ctx.createRadialGradient(c + r * 0.3, c + r * 0.38, 0, c + r * 0.3, c + r * 0.38, r * 0.62);
      sss.addColorStop(0, mix(color, '#ffffff', 0.62, 0.85));
      sss.addColorStop(1, mix(color, '#ffffff', 0.4, 0));
      ctx.fillStyle = sss;
      ctx.fillRect(0, 0, S, S);
      // Fresnel rim.
      const rim = ctx.createRadialGradient(c, c, r * 0.76, c, c, r);
      rim.addColorStop(0, 'rgba(255,255,255,0)');
      rim.addColorStop(1, 'rgba(255,255,255,0.38)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, S, S);
      ctx.globalCompositeOperation = 'source-over';
      // Softbox mirror pool and a cool rim glint.
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.ellipse(c - r * 0.34, c - r * 0.4, r * 0.3, r * 0.17, -0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(235,245,255,0.7)';
      ctx.beginPath();
      ctx.arc(c + r * 0.46, c - r * 0.3, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Faceted sugar crystal: two lit facets, a bright ridge and a crisp outline. */
  private shardSprite(color: string): HTMLCanvasElement {
    return this.sprite(`shard:${color}`, 32, (ctx, S) => {
      const c = S / 2;
      const top: [number, number] = [c, S * 0.04];
      const bot: [number, number] = [c, S * 0.96];
      const l: [number, number] = [S * 0.3, S * 0.42];
      const rr: [number, number] = [S * 0.7, S * 0.5];
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(rr[0], rr[1]);
      ctx.lineTo(bot[0], bot[1]);
      ctx.lineTo(l[0], l[1]);
      ctx.closePath();
      ctx.fillStyle = mix(color, '#ffffff', 0.15, 0.92);
      ctx.fill();
      // Lit left facet.
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(c, c);
      ctx.lineTo(bot[0], bot[1]);
      ctx.lineTo(l[0], l[1]);
      ctx.closePath();
      ctx.fillStyle = mix(color, '#ffffff', 0.65, 0.95);
      ctx.fill();
      // Ridge + outline.
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = S * 0.05;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(c, c);
      ctx.lineTo(bot[0], bot[1]);
      ctx.stroke();
      ctx.strokeStyle = mix(color, '#ffffff', 0.4, 0.8);
      ctx.lineWidth = S * 0.03;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(rr[0], rr[1]);
      ctx.lineTo(bot[0], bot[1]);
      ctx.lineTo(l[0], l[1]);
      ctx.closePath();
      ctx.stroke();
    });
  }

  private sparkSprite(color: string): HTMLCanvasElement {
    return this.sprite(`spark:${color}`, 32, (ctx, S) => {
      const c = S / 2;
      const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
      glow.addColorStop(0, withAlpha(color, 0.65));
      glow.addColorStop(0.4, withAlpha(color, 0.18));
      glow.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      const r = c * 0.95;
      ctx.moveTo(c, c - r);
      ctx.quadraticCurveTo(c, c, c + r, c);
      ctx.quadraticCurveTo(c, c, c, c + r);
      ctx.quadraticCurveTo(c, c, c - r, c);
      ctx.quadraticCurveTo(c, c, c, c - r);
      ctx.fill();
    });
  }

  /**
   * Glossy candy-glass bee body for flight, head facing +x: teardrop body with a
   * studio softbox highlight, honey belly bands, stinger, eye and blush.
   */
  private beeSprite(color: string): HTMLCanvasElement {
    return this.sprite(`bee:${color}`, 64, (ctx, S) => {
      const cx = S * 0.52;
      const cy = S * 0.54;
      const rx = S * 0.36;
      const ry = S * 0.27;
      const body = new Path2D();
      // Teardrop: round head at +x, tapering to a tail at -x.
      body.moveTo(cx + rx, cy);
      body.bezierCurveTo(cx + rx, cy - ry * 1.38, cx - rx * 0.55, cy - ry * 1.18, cx - rx * 1.02, cy - ry * 0.12);
      body.quadraticCurveTo(cx - rx * 1.12, cy + ry * 0.06, cx - rx * 1.0, cy + ry * 0.22);
      body.bezierCurveTo(cx - rx * 0.5, cy + ry * 1.2, cx + rx, cy + ry * 1.38, cx + rx, cy);
      body.closePath();
      // Stinger.
      ctx.fillStyle = '#7a3d08';
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.98, cy - ry * 0.12);
      ctx.lineTo(cx - rx * 1.32, cy + ry * 0.08);
      ctx.lineTo(cx - rx * 0.98, cy + ry * 0.26);
      ctx.closePath();
      ctx.fill();
      // Body: lit glass candy.
      const g = ctx.createRadialGradient(cx + rx * 0.25, cy - ry * 0.45, ry * 0.1, cx, cy, rx * 1.15);
      g.addColorStop(0, mix(color, '#ffffff', 0.55));
      g.addColorStop(0.45, mix(color, '#ffffff', 0.08));
      g.addColorStop(0.85, mix(color, '#000000', 0.25));
      g.addColorStop(1, mix(color, '#000000', 0.45));
      ctx.fillStyle = g;
      ctx.fill(body);
      ctx.save();
      ctx.clip(body);
      // Honey bands bowed over the dome.
      const stripe = beeStripeColor(color);
      ctx.strokeStyle = stripe;
      ctx.lineWidth = S * 0.075;
      for (const k of [-0.62, -0.28, 0.06]) {
        const x = cx + rx * k;
        ctx.beginPath();
        ctx.moveTo(x + rx * 0.08, cy - ry * 1.3);
        ctx.quadraticCurveTo(x - rx * 0.12, cy, x + rx * 0.08, cy + ry * 1.3);
        ctx.stroke();
      }
      // Subsurface glow in the lower body and a glassy rim.
      const sss = ctx.createRadialGradient(cx - rx * 0.1, cy + ry * 0.7, 0, cx - rx * 0.1, cy + ry * 0.7, rx);
      sss.addColorStop(0, mix(color, '#ffffff', 0.5, 0.55));
      sss.addColorStop(1, mix(color, '#ffffff', 0.3, 0));
      ctx.fillStyle = sss;
      ctx.fillRect(0, 0, S, S);
      ctx.restore();
      ctx.lineWidth = S * 0.02;
      ctx.strokeStyle = mix(color, '#ffffff', 0.7, 0.7);
      ctx.stroke(body);
      // Rosy cheek, eye with catchlight, tiny smile.
      ctx.fillStyle = 'rgba(255,140,170,0.5)';
      ctx.beginPath();
      ctx.ellipse(cx + rx * 0.62, cy + ry * 0.42, S * 0.05, S * 0.032, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#12061a';
      ctx.beginPath();
      ctx.arc(cx + rx * 0.62, cy - ry * 0.05, S * 0.048, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx + rx * 0.58, cy - ry * 0.16, S * 0.018, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,10,30,0.8)';
      ctx.lineWidth = S * 0.016;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx + rx * 0.86, cy + ry * 0.2, S * 0.035, 0.3, Math.PI * 0.85);
      ctx.stroke();
      // Softbox mirror pool across the crown.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.ellipse(cx + rx * 0.05, cy - ry * 0.62, rx * 0.42, ry * 0.16, -0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(235,245,255,0.7)';
      ctx.beginPath();
      ctx.arc(cx + rx * 0.72, cy + ry * 0.55, S * 0.018, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Translucent iridescent glass wing, root at the left-centre of the sprite. */
  private wingSprite(): HTMLCanvasElement {
    return this.sprite('bee-wing', 48, (ctx, S) => {
      const path = new Path2D();
      path.ellipse(S * 0.5, S * 0.5, S * 0.46, S * 0.26, 0, 0, Math.PI * 2);
      const g = ctx.createLinearGradient(0, 0, S, S * 0.6);
      g.addColorStop(0, 'rgba(200,240,255,0.55)');
      g.addColorStop(0.35, 'rgba(255,215,250,0.45)');
      g.addColorStop(0.65, 'rgba(255,250,200,0.45)');
      g.addColorStop(1, 'rgba(190,255,225,0.5)');
      ctx.fillStyle = g;
      ctx.fill(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = S * 0.045;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = S * 0.02;
      ctx.beginPath();
      ctx.moveTo(S * 0.08, S * 0.52);
      ctx.quadraticCurveTo(S * 0.5, S * 0.38, S * 0.9, S * 0.46);
      ctx.moveTo(S * 0.3, S * 0.45);
      ctx.quadraticCurveTo(S * 0.55, S * 0.62, S * 0.78, S * 0.66);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.ellipse(S * 0.62, S * 0.36, S * 0.16, S * 0.05, -0.2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Draws one flying bee (trail is drawn separately, under the particles). */
  private drawBee(ctx: Ctx, b: BeeFlight): void {
    const fade = b.arrived ? Math.max(0, 1 - b.linger / 0.12) : 1;
    if (fade <= 0) return;
    const s = b.size;
    const stretch = this.reducedMotion ? 1 : Math.min(1.22, 1 + b.speed / (s * 40));
    const arrivePop = b.arrived ? 1 + b.linger * 3 : 1;
    // Glow halo behind the bee (bigger when carrying a special payload).
    const halo = s * (b.payload === 'none' ? 1.25 : 1.7);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * fade;
    ctx.drawImage(this.glowSprite(b.color), b.x - halo / 2, b.y - halo / 2, halo, halo);
    if (b.payload !== 'none') {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 30);
      ctx.globalAlpha = (0.35 + 0.35 * pulse) * fade;
      ctx.drawImage(this.glowSprite('#ffffff'), b.x - halo * 0.35, b.y - halo * 0.35, halo * 0.7, halo * 0.7);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = fade;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.heading);
    // Keep the bee upright whichever way it flies.
    if (Math.cos(b.heading) < 0) ctx.scale(1, -1);
    ctx.scale(stretch * arrivePop, arrivePop / stretch);
    const bw = s * 0.9;
    // Back wing, body, front wing: fluttering by squashing each wing's height.
    const flap = Math.sin(b.wing);
    const wing = this.wingSprite();
    const drawWing = (ang: number, sy: number, alpha: number) => {
      ctx.save();
      ctx.translate(-bw * 0.02, -bw * 0.16);
      ctx.rotate(ang);
      ctx.scale(1, Math.max(0.12, sy));
      ctx.globalAlpha = fade * alpha;
      ctx.drawImage(wing, 0, -bw * 0.2, bw * 0.62, bw * 0.4);
      ctx.restore();
    };
    drawWing(-2.2 + flap * 0.25, 0.35 + 0.65 * Math.abs(Math.cos(b.wing + 0.6)), 0.75);
    ctx.globalAlpha = fade;
    ctx.drawImage(this.beeSprite(b.color), -bw / 2, -bw / 2, bw, bw);
    drawWing(-1.75 - flap * 0.3, 0.3 + 0.7 * Math.abs(flap), 0.9);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private glowSprite(color: string): HTMLCanvasElement {
    return this.sprite(`glow:${color}`, 64, (ctx, S) => {
      const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.2, withAlpha(color, 0.9));
      g.addColorStop(0.55, withAlpha(color, 0.3));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    });
  }

  draw(ctx: Ctx, viewW: number, viewH: number): void {
    ctx.save();

    // Shockwave rings.
    for (const r of this.rings) {
      const p = 1 - r.life / r.max;
      const e = 1 - Math.pow(1 - p, 3);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const a = Math.pow(1 - p, 1.4);
      ctx.globalCompositeOperation = 'lighter';
      // Luminous core flash as the ring is born.
      if (p < 0.35) {
        const k = 1 - p / 0.35;
        const gs = this.glowSprite(r.color);
        const sz = rad * 1.4;
        ctx.globalAlpha = 0.55 * k;
        ctx.drawImage(gs, r.x - sz / 2, r.y - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      // Soft bloom halo around the ring.
      ctx.lineWidth = Math.max(2, r.width * 3.2 * (1 - p * 0.6));
      ctx.strokeStyle = withAlpha(r.color, 0.16 * a);
      ctx.stroke();
      const fill = ctx.createRadialGradient(r.x, r.y, rad * 0.55, r.x, r.y, rad);
      fill.addColorStop(0, withAlpha(r.color, 0));
      fill.addColorStop(1, withAlpha(r.color, 0.22 * a));
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = Math.max(1, r.width * (1 - p * 0.8));
      ctx.strokeStyle = `rgba(255,255,255,${0.75 * a})`;
      ctx.stroke();
      ctx.lineWidth = Math.max(1, r.width * 0.45 * (1 - p * 0.8));
      ctx.strokeStyle = withAlpha(r.color, 0.9 * a);
      ctx.stroke();
    }

    // Laser beams.
    ctx.lineCap = 'round';
    for (const b of this.beams) {
      const t = b.max - b.life;
      const grow = 0.11;
      const ext = Math.min(1, t / grow);
      const e = 1 - Math.pow(1 - ext, 3);
      const env = t < grow ? 0.7 + 0.3 * e : Math.pow(Math.max(0, 1 - (t - grow) / (b.max - grow)), 0.8);
      const ax = b.ox + (b.ax - b.ox) * e;
      const ay = b.oy + (b.ay - b.oy) * e;
      const bx = b.ox + (b.bx - b.ox) * e;
      const by = b.oy + (b.by - b.oy) * e;
      const th = b.thickness * env;
      const flick = 0.9 + Math.sin(this.time * 90 + b.ox) * 0.1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineWidth = th * 6 * flick;
      ctx.strokeStyle = withAlpha(b.color, 0.08 * env);
      ctx.stroke();
      ctx.lineWidth = th * 3.4 * flick;
      ctx.strokeStyle = withAlpha(b.color, 0.22 * env);
      ctx.stroke();
      ctx.lineWidth = th * 1.6;
      ctx.strokeStyle = withAlpha(b.color, 0.75 * env);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = th * 0.55;
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, env * 1.2)})`;
      ctx.stroke();
      // Energy shimmer racing outward along the beam.
      ctx.globalCompositeOperation = 'lighter';
      ctx.setLineDash([th * 0.7, th * 1.5]);
      ctx.lineDashOffset = this.reducedMotion ? 0 : -this.time * th * 22;
      ctx.lineWidth = th * 0.9;
      ctx.strokeStyle = mix(b.color, '#ffffff', 0.7, 0.55 * env);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'source-over';
      // Hot end caps.
      const gs = this.glowSprite(b.color);
      const cap = th * 3;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = env;
      ctx.drawImage(gs, ax - cap / 2, ay - cap / 2, cap, cap);
      ctx.drawImage(gs, bx - cap / 2, by - cap / 2, cap, cap);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Lightning arcs.
    ctx.lineJoin = 'round';
    for (const b of this.bolts) {
      const p = b.life / b.max;
      const col = b.color === 'rainbow' ? `hsl(${(b.hue + this.time * 540) % 360}, 100%, 66%)` : b.color;
      b.points.forEach((pts, i) => {
        const w = i === 0 ? 1 : 0.55;
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.globalCompositeOperation = 'lighter';
        // Wide atmospheric bloom.
        ctx.lineWidth = 24 * w;
        ctx.strokeStyle = b.color === 'rainbow' ? `hsla(${(b.hue + this.time * 540) % 360}, 100%, 70%, ${0.1 * p})` : withAlpha(col, 0.1 * p);
        ctx.stroke();
        ctx.lineWidth = 11 * w;
        ctx.strokeStyle = b.color === 'rainbow' ? `hsla(${(b.hue + this.time * 540) % 360}, 100%, 60%, ${0.3 * p})` : withAlpha(col, 0.3 * p);
        ctx.stroke();
        ctx.lineWidth = 4.5 * w;
        ctx.strokeStyle = b.color === 'rainbow' ? `hsla(${(b.hue + this.time * 540 + 40) % 360}, 100%, 65%, ${0.85 * p})` : withAlpha(col, 0.85 * p);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 1.6 * w;
        ctx.strokeStyle = `rgba(255,255,255,${p})`;
        ctx.stroke();
      });
      const gs = this.glowSprite('#ffffff');
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = p;
      ctx.drawImage(gs, b.x2 - 26, b.y2 - 26, 52, 52);
      // Origin flare.
      ctx.globalAlpha = p * 0.6;
      ctx.drawImage(gs, b.x1 - 20, b.y1 - 20, 40, 40);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Comets.
    for (const c of this.comets) {
      if (c.delay > 0 || c.trail.length === 0) continue;
      const fade = c.arrived ? Math.max(0, 1 - (c.t - 1) * 4) : 1;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = c.trail.length - 1; i > 0; i--) {
        const [x0, y0] = c.trail[i];
        const [x1, y1] = c.trail[i - 1];
        const k = 1 - i / c.trail.length;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineWidth = 3 + k * 10;
        ctx.strokeStyle = withAlpha(c.color, 0.55 * k * fade);
        ctx.stroke();
      }
      if (!c.arrived) {
        const [hx, hy] = c.trail[0];
        const gs = this.glowSprite(c.color);
        ctx.drawImage(gs, hx - 22, hy - 22, 44, 44);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Sugar Bee pollen ribbons (under the droplets and sparkles).
    if (this.bees.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const b of this.bees) {
        if (b.delay > 0 || b.trail.length < 2) continue;
        for (let i = b.trail.length - 1; i > 0; i--) {
          const [x0, y0] = b.trail[i];
          const [x1, y1] = b.trail[i - 1];
          const k = 1 - i / b.trail.length;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.lineWidth = b.size * (0.05 + 0.22 * k);
          ctx.strokeStyle = withAlpha(GOLD_POLLEN, 0.42 * k);
          ctx.stroke();
          ctx.lineWidth = b.size * (0.02 + 0.08 * k);
          ctx.strokeStyle = mix(b.color, '#ffffff', 0.5, 0.6 * k);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Bee impact starbursts.
    for (const sb of this.starbursts) {
      const p = 1 - sb.life / sb.max;
      const e = 1 - Math.pow(1 - p, 3);
      const a = 1 - p;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(sb.x, sb.y);
      ctx.rotate(sb.rot);
      ctx.lineCap = 'round';
      for (let i = 0; i < sb.rays; i++) {
        const ang = (i / sb.rays) * Math.PI * 2;
        const long = i % 2 === 0 ? 1 : 0.62;
        const r0 = sb.r * 0.22 * e;
        const r1 = sb.r * (0.3 + 0.7 * e) * long;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.lineWidth = sb.r * 0.16 * a;
        ctx.strokeStyle = withAlpha(sb.color, 0.5 * a);
        ctx.stroke();
        ctx.lineWidth = sb.r * 0.06 * a;
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
        ctx.stroke();
      }
      const core = sb.r * (0.9 - 0.4 * p);
      ctx.globalAlpha = a;
      ctx.drawImage(this.glowSprite(GOLD_POLLEN), -core / 2, -core / 2, core, core);
      ctx.restore();
    }

    // Droplets.
    for (let i = 0; i < this.dropCount; i++) {
      const d = this.drops[i];
      const p = d.life / d.max;
      const r = d.r * (0.35 + 0.65 * p);
      const sp = this.dropSprite(d.color);
      const stretch = Math.min(1.6, 1 + Math.hypot(d.vx, d.vy) / 1800);
      const ang = Math.atan2(d.vy, d.vx);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.6);
      ctx.translate(d.x, d.y);
      ctx.rotate(ang);
      ctx.scale(stretch, 1 / stretch);
      ctx.drawImage(sp, -r, -r, r * 2, r * 2);
      ctx.restore();
    }

    // Sugar shards: tumble via a squashed axis; flash when a facet faces the light.
    for (let i = 0; i < this.shardCount; i++) {
      const s = this.shards[i];
      const p = s.life / s.max;
      const flipK = Math.cos(s.flip);
      const sx = Math.max(0.18, Math.abs(flipK));
      const size = s.size * (0.6 + 0.4 * p);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.8);
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.scale(sx, 1);
      ctx.drawImage(this.shardSprite(s.color), -size / 2, -size, size, size * 2);
      ctx.restore();
      if (sx > 0.9) {
        const k = (sx - 0.9) / 0.1;
        const gsz = size * 2.6;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, p * 1.5) * k * 0.85;
        ctx.drawImage(this.sparkSprite('#ffffff'), s.x - gsz / 2, s.y - gsz / 2, gsz, gsz);
        ctx.restore();
      }
    }

    // Sparkles.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.sparkCount; i++) {
      const s = this.sparks[i];
      const p = s.life / s.max;
      const tw = 0.6 + 0.4 * Math.sin(this.time * 22 + s.twinkle);
      const size = s.size * (p < 0.8 ? p / 0.8 : (1 - p) * 5) * tw * 2;
      if (size <= 0.2) continue;
      const sp = this.sparkSprite(s.color);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.5);
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.drawImage(sp, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Flying Sugar Bees ride above every particle.
    for (const b of this.bees) {
      if (b.delay > 0) continue;
      this.drawBee(ctx, b);
    }

    // Score popups.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const p of this.popups) {
      const t = 1 - p.life / p.max;
      const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.55 : t < 0.3 ? 1.15 - ((t - 0.15) / 0.15) * 0.15 : 1;
      const rise = (this.reducedMotion ? 18 : 42) * (1 - Math.pow(1 - t, 2));
      const alpha = t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y - rise);
      ctx.scale(pop, pop);
      ctx.font = `800 ${p.size}px ${FONT_STACK}`;
      ctx.lineWidth = p.size * 0.28;
      ctx.strokeStyle = 'rgba(60,10,40,0.85)';
      ctx.strokeText(p.text, 0, 0);
      ctx.lineWidth = p.size * 0.14;
      ctx.strokeStyle = p.color;
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }

    // Praise banners.
    for (const b of this.banners) {
      const t = b.max - b.life;
      const fadeIn = this.reducedMotion ? Math.min(1, t / 0.15) : 1;
      const fadeOut = b.life < 0.3 ? b.life / 0.3 : 1;
      const rise = b.life < 0.3 ? (1 - b.life / 0.3) * 24 : 0;
      ctx.save();
      ctx.globalAlpha = fadeIn * fadeOut;
      ctx.translate(b.x, b.y - rise);
      const s = Math.max(0.01, b.scale);
      ctx.scale(s, s);
      ctx.rotate(-0.06);
      ctx.font = `900 ${b.size}px ${FONT_STACK}`;
      const w = ctx.measureText(b.text).width;
      ctx.shadowColor = 'rgba(70,10,40,0.55)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 6;
      ctx.lineWidth = b.size * 0.26;
      ctx.strokeStyle = b.big ? '#7a0e4a' : '#7a2e00';
      ctx.strokeText(b.text, 0, 0);
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = b.size * 0.13;
      ctx.strokeStyle = '#fff6dc';
      ctx.strokeText(b.text, 0, 0);
      const fg = ctx.createLinearGradient(0, -b.size * 0.5, 0, b.size * 0.5);
      if (b.big) {
        fg.addColorStop(0, '#fff4fb');
        fg.addColorStop(0.35, '#ff9ad5');
        fg.addColorStop(0.6, '#ffd23f');
        fg.addColorStop(1, '#ff7a1a');
      } else {
        fg.addColorStop(0, '#fffbd0');
        fg.addColorStop(0.45, '#ffd23f');
        fg.addColorStop(1, '#ff8f1a');
      }
      ctx.fillStyle = fg;
      ctx.fillText(b.text, 0, 0);
      // Golden shimmer sweep.
      const sweep = ((t * 0.9) % 1.2) - 0.1;
      const x = -w / 2 + w * sweep;
      const sg = ctx.createLinearGradient(x - b.size * 0.6, 0, x + b.size * 0.6, 0);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
      if (!this.reducedMotion && Math.random() < 0.35) {
        this.sparkle(b.x + (Math.random() - 0.5) * w * s, b.y + (Math.random() - 0.5) * b.size * s, 1, '#ffe27a', 4, 40);
      }
    }

    // Screen flash.
    if (this.flashAlpha > 0.005) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = withAlpha(this.flashColor, this.flashAlpha);
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }
}
