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

export class ParticleSystem {
  private drops: Droplet[] = [];
  private dropCount = 0;
  private sparks: Spark[] = [];
  private sparkCount = 0;
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private bolts: Bolt[] = [];
  private comets: Comet[] = [];
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
      this.dropCount + this.sparkCount + this.rings.length + this.beams.length + this.bolts.length + this.comets.length + this.popups.length + this.banners.length >
      0
    );
  }

  clear(): void {
    this.dropCount = 0;
    this.sparkCount = 0;
    this.rings.length = 0;
    this.beams.length = 0;
    this.bolts.length = 0;
    this.comets.length = 0;
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

  /** Glossy jelly droplets bursting from a cleared candy. */
  jellyBurst(x: number, y: number, color: string, count = 10, power = 1, cellSize = 60): void {
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

    this.rings = this.rings.filter((r) => (r.life -= dt) > 0);
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

  private dropSprite(color: string): HTMLCanvasElement {
    return this.sprite(`drop:${color}`, 32, (ctx, S) => {
      const g = ctx.createRadialGradient(S * 0.38, S * 0.34, S * 0.02, S * 0.5, S * 0.52, S * 0.5);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.18, withAlpha(color, 1));
      g.addColorStop(0.8, withAlpha(color, 0.95));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.arc(S * 0.56, S * 0.6, S * 0.3, 0, Math.PI * 2);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.ellipse(S * 0.36, S * 0.32, S * 0.11, S * 0.07, -0.6, 0, Math.PI * 2);
      ctx.fill();
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
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
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
      ctx.drawImage(gs, b.x2 - 18, b.y2 - 18, 36, 36);
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
