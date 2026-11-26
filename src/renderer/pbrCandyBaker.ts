/**
 * Sugar Snap — per-pixel studio-lit PBR candy baker.
 *
 * Every sprite is rasterised into a small G-buffer (height, coverage, albedo,
 * material, emissive) from analytic signed-distance / height-field geometry,
 * then lit per pixel by a virtual photo studio:
 *
 *  - an arched overhead softbox, a cool upper-right rim reflector and a warm
 *    pastel bounce floor, all sampled along the true reflection vector
 *    R = reflect(-V, N) so every curve carries a crisp wet-lacquer mirror pool;
 *  - dual Blinn-Phong lobes (broad lacquer + razor mirror glint);
 *  - Schlick Fresnel (^4) glassy rim;
 *  - subsurface translucency pooling in thin edges and the lower-right, opposite
 *    the key light;
 *  - cavity occlusion from a blurred height field;
 *  - a candy-tinted caustic contact shadow.
 *
 * Pure math with no DOM access: it returns straight-alpha RGBA bytes ready for
 * ImageData, so it runs (and benchmarks) in Node as well as the browser. Every
 * bake is deterministic (no Math.random).
 *
 * Coordinates: x, y in [-1, 1] across the sprite, y pointing down; heights are
 * in the same units so normals are geometrically true.
 */

export type PbrCandyColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type PbrCandySpecial = 'none' | 'striped-h' | 'striped-v' | 'wrapped' | 'seeker';

export type PbrSpriteSpec =
  | { kind: 'candy'; color: PbrCandyColor | 'none'; special: PbrCandySpecial }
  | { kind: 'bomb' }
  | { kind: 'cherry' }
  | { kind: 'hazelnut' }
  | { kind: 'frosting'; layers: 1 | 2 | 3 }
  | { kind: 'chocolate' }
  | { kind: 'locked' }
  | { kind: 'jelly'; layers: 1 | 2 };

export interface PbrBakeResult {
  size: number;
  /** Straight-alpha RGBA, row-major, size × size. */
  pixels: Uint8ClampedArray;
  /**
   * Glint layer for additive ('lighter') compositing: the surface's response to
   * a sharp diagonal light streak, used by the board's moving glass-glint sweep.
   */
  sheen: Uint8ClampedArray | null;
}

/** Sprite bake resolution for a cell: crisp on Retina, bounded for speed. */
export function pbrBakeSize(cellSize: number, dpr: number): number {
  return Math.min(192, Math.max(96, Math.ceil(cellSize * dpr)));
}

/* -------------------------------------------------------------------------- */
/* Math helpers                                                                */
/* -------------------------------------------------------------------------- */

type RGB = readonly [number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Math.hypot is slow in hot loops; this is the plain 2D length. */
const len2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum (iq). */
function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * h - k * h * (1 - h);
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** Circular-arc bevel profile: inside distance t → height, saturating at R. */
function inflate(t: number, R: number): number {
  if (t <= 0) return 0;
  if (t >= R) return R;
  const u = t / R;
  return R * Math.sqrt(u * (2 - u));
}

function sdRoundBox(x: number, y: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(x) - bx + r;
  const qy = Math.abs(y) - by + r;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Ellipse distance (gradient-normalised implicit; exact enough for AA). */
function sdEllipse(x: number, y: number, a: number, b: number): number {
  const k0 = Math.sqrt((x * x) / (a * a) + (y * y) / (b * b));
  const k1 = Math.sqrt((x * x) / (a * a * a * a) + (y * y) / (b * b * b * b));
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Teardrop (iq's uneven capsule) in y-up space: a round base of radius r1 at
 * the origin flowing smoothly into a rounded tip of radius r2 at (0, hgt).
 */
function sdTeardrop(px: number, py: number, r1: number, r2: number, hgt: number): number {
  px = Math.abs(px);
  const b = (r1 - r2) / hgt;
  const a = Math.sqrt(1 - b * b);
  const k = -b * px + a * py;
  if (k < 0) return len2(px, py) - r1;
  if (k > a * hgt) return len2(px, py - hgt) - r2;
  return px * a + py * b - r1;
}

/** Superellipse "squircle" distance (gradient-normalised; exact enough for AA). */
function sdSquircle(x: number, y: number, a: number, n: number): number {
  const ax = Math.abs(x) / a + 1e-6;
  const ay = Math.abs(y) / a + 1e-6;
  const px = Math.pow(ax, n);
  const py = Math.pow(ay, n);
  const r = Math.pow(px + py, 1 / n);
  // |∇r| = sqrt(gx² + gy²), gx = (ax/r)^(n-1) / a.
  const gx = Math.pow(ax / r, n - 1);
  const gy = Math.pow(ay / r, n - 1);
  return ((r - 1) * a) / Math.sqrt(gx * gx + gy * gy);
}

function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function hexRGB(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                   */
/* -------------------------------------------------------------------------- */

interface Mat {
  /** Environment reflection multiplier. */
  spec: number;
  /** Fresnel reflectance at normal incidence. */
  f0: number;
  /** Broad lacquer lobe (shininess ~24). */
  broad: number;
  /** Razor mirror lobe intensity. */
  sharp: number;
  /** Sharp lobe exponent = 2^sharpSq (7 → 128, 8 → 256). */
  sharpSq: number;
  /** Subsurface translucency strength and colour. */
  sss: number;
  sssC: RGB;
  /** Fresnel glass rim glow strength and colour. */
  rim: number;
  rimC: RGB;
  diff: number;
  amb: number;
  /** Opacity of the body (films < 1 get alpha from their reflections). */
  op: number;
  /** How strongly albedo saturates toward grazing angles (thick-path absorption). */
  deepen: number;
  /** Strength of the glint-sweep response. */
  sheen: number;
}

const BASE_MAT: Mat = {
  spec: 1,
  f0: 0.07,
  broad: 0.4,
  sharp: 1.6,
  sharpSq: 8,
  sss: 0.6,
  sssC: [1, 0.8, 0.7],
  rim: 0.35,
  rimC: [1, 0.95, 0.98],
  diff: 0.82,
  amb: 0.36,
  op: 1,
  deepen: 0.75,
  sheen: 1,
};

function mat(p: Partial<Mat>): Mat {
  return { ...BASE_MAT, ...p };
}

/* -------------------------------------------------------------------------- */
/* Studio lighting                                                             */
/* -------------------------------------------------------------------------- */

/** Key softbox direction (upper-left, toward viewer). */
const KEY = norm3(-0.42, -0.6, 0.68);
/** Cool rim reflector (upper-right). */
const RIM = norm3(0.7, -0.46, 0.55);
const H_KEY = norm3(KEY[0], KEY[1], KEY[2] + 1);
const H_RIM = norm3(RIM[0], RIM[1], RIM[2] + 1);
/** Pinpoint sparkle: a tiny hot point light whose glint sits up and right of the softbox pool. */
const H_PIN = norm3(0.15, -0.44, 0.88);
const HPX = H_PIN[0], HPY = H_PIN[1], HPZ = H_PIN[2];

function frame(d: readonly number[]): { t1: number[]; t2: number[] } {
  // t1: horizontal tangent (softbox width), t2: completes the frame (softbox height).
  const t1 = norm3(d[1], -d[0], 0);
  const t2 = [t1[1] * d[2] - t1[2] * d[1], t1[2] * d[0] - t1[0] * d[2], t1[0] * d[1] - t1[1] * d[0]];
  return { t1, t2 };
}
const KF = frame(KEY);
const RF = frame(RIM);
// Scalar copies: the shading loop reads these millions of times.
const KX = KEY[0], KY = KEY[1], KZ = KEY[2];
const RX = RIM[0], RY = RIM[1], RZ = RIM[2];
const K1X = KF.t1[0], K1Y = KF.t1[1], K1Z = KF.t1[2];
const K2X = KF.t2[0], K2Y = KF.t2[1], K2Z = KF.t2[2];
const R1X = RF.t1[0], R1Y = RF.t1[1], R1Z = RF.t1[2];
const R2X = RF.t2[0], R2Y = RF.t2[1], R2Z = RF.t2[2];
const HKX = H_KEY[0], HKY = H_KEY[1], HKZ = H_KEY[2];
const HRX = H_RIM[0], HRY = H_RIM[1], HRZ = H_RIM[2];

/** Environment radiance output (r, g, b). */
const E = new Float64Array(3);

/** Studio environment radiance along direction (rx, ry, rz); writes E. */
function env(rx: number, ry: number, rz: number): void {
  // Dome base: cool lavender sky above, warm pastel floor below, soft lilac behind.
  const up = clamp01(0.5 - ry * 0.5);
  let er = 0.2 + 0.12 * up;
  let eg = 0.18 + 0.13 * up;
  let eb = 0.24 + 0.16 * up;
  if (rz < 0.1) {
    const k = smoothstep(0.1, -0.6, rz) * 0.42;
    er += 0.95 * k;
    eg += 0.78 * k;
    eb += 1.0 * k;
  }
  // Warm bounce floor.
  if (ry > 0.05) {
    const k = smoothstep(0.05, 0.85, ry) * 0.95;
    er += 1.0 * k;
    eg += 0.72 * k;
    eb += 0.56 * k;
  }
  // Arched overhead softbox: sharp-edged, faintly graded.
  const w = rx * KX + ry * KY + rz * KZ;
  if (w > 0.25) {
    const iw = 1 / w;
    const u = (rx * K1X + ry * K1Y + rz * K1Z) * iw;
    const v = (rx * K2X + ry * K2Y + rz * K2Z) * iw + 0.42 * u * u; // arch the window
    const sd = sdRoundBox(u, v, 0.62, 0.3, 0.22);
    if (sd < 0.06) {
      const m = smoothstep(0.06, -0.04, sd) * (6.4 + 1.8 * smoothstep(0.3, -0.3, v));
      er += m;
      eg += m * 0.985;
      eb += m * 0.95;
    }
  }
  // Cool strip reflector, upper right.
  const w2 = rx * RX + ry * RY + rz * RZ;
  if (w2 > 0.3) {
    const iw = 1 / w2;
    const u = (rx * R1X + ry * R1Y + rz * R1Z) * iw;
    const v = (rx * R2X + ry * R2Y + rz * R2Z) * iw;
    const sd = sdRoundBox(u, v, 0.14, 0.5, 0.12);
    if (sd < 0.05) {
      const m = smoothstep(0.05, -0.03, sd) * 2.1;
      er += m * 0.82;
      eg += m * 0.92;
      eb += m;
    }
  }
  E[0] = er;
  E[1] = eg;
  E[2] = eb;
}

/* -------------------------------------------------------------------------- */
/* G-buffer                                                                    */
/* -------------------------------------------------------------------------- */

interface Sample {
  h: number;
  /** Signed distance to the silhouette (negative inside). */
  d: number;
  r: number;
  g: number;
  b: number;
  m: number;
  /** Emissive white (sugar sparkles, facet ridges). */
  e: number;
}

type SampleFn = (x: number, y: number, s: Sample) => void;

interface GBuf {
  S: number;
  h: Float32Array;
  cov: Float32Array;
  alb: Float32Array;
  m: Uint8Array;
  e: Float32Array;
}

function raster(S: number, fn: SampleFn): GBuf {
  const n = S * S;
  const px = 2 / S;
  const g: GBuf = { S, h: new Float32Array(n), cov: new Float32Array(n), alb: new Float32Array(n * 3), m: new Uint8Array(n), e: new Float32Array(n) };
  const s: Sample = { h: 0, d: 1, r: 0, g: 0, b: 0, m: 0, e: 0 };
  for (let j = 0; j < S; j++) {
    const y = (j + 0.5) * px - 1;
    for (let i = 0; i < S; i++) {
      const x = (i + 0.5) * px - 1;
      s.h = 0;
      s.d = 1;
      s.r = s.g = s.b = 0;
      s.m = 0;
      s.e = 0;
      fn(x, y, s);
      const c = 0.5 - s.d / px;
      if (c <= 0) continue;
      const k = j * S + i;
      g.cov[k] = c >= 1 ? 1 : c;
      g.h[k] = s.h > 0 ? s.h : 0;
      g.alb[k * 3] = s.r;
      g.alb[k * 3 + 1] = s.g;
      g.alb[k * 3 + 2] = s.b;
      g.m[k] = s.m;
      g.e[k] = s.e;
    }
  }
  return g;
}

/** Separable box blur (two iterations ≈ gaussian), zero outside. */
function blur(src: Float32Array, S: number, r: number, iterations = 2): Float32Array {
  r = Math.max(1, Math.round(r));
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < S; j++) {
      const o = j * S;
      let acc = 0;
      for (let i = -r; i <= r; i++) if (i >= 0 && i < S) acc += a[o + i];
      for (let i = 0; i < S; i++) {
        b[o + i] = acc * inv;
        const add = i + r + 1;
        const sub = i - r;
        if (add < S) acc += a[o + add];
        if (sub >= 0) acc -= a[o + sub];
      }
    }
    for (let i = 0; i < S; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) if (j >= 0 && j < S) acc += b[j * S + i];
      for (let j = 0; j < S; j++) {
        a[j * S + i] = acc * inv;
        const add = j + r + 1;
        const sub = j - r;
        if (add < S) acc += b[add * S + i];
        if (sub >= 0) acc -= b[sub * S + i];
      }
    }
  }
  return a;
}

/* -------------------------------------------------------------------------- */
/* Shading                                                                     */
/* -------------------------------------------------------------------------- */

interface ShadeOpts {
  /** Normal strength multiplier (stylised relief). */
  ns?: number;
  /** Cavity occlusion strength and blur radius (fraction of S). */
  ao?: number;
  aoR?: number;
  sheen?: boolean;
}

interface Shaded {
  /** Premultiplied RGBA floats. */
  col: Float32Array;
  sheen: Float32Array | null;
}

function tone(v: number): number {
  if (v <= 0.8) return v < 0 ? 0 : v;
  return 1 - 0.2 * Math.exp(-(v - 0.8) * 5);
}

function shade(g: GBuf, mats: readonly Mat[], o: ShadeOpts = {}): Shaded {
  const S = g.S;
  const n = S * S;
  const px = 2 / S;
  const ns = o.ns ?? 1;
  const aoK = o.ao ?? 2.2;
  const hb = aoK > 0 ? blur(g.h, S, S * (o.aoR ?? 0.045), 1) : null;
  const col = new Float32Array(n * 4);
  const sheen = o.sheen ? new Float32Array(n * 4) : null;
  const { h, cov, alb, m: mid, e: emis } = g;
  const inv1 = ns / px;
  const inv2 = ns / (2 * px);

  for (let j = 0; j < S; j++) {
    const py = (j + 0.5) * px - 1 - CY;
    for (let i = 0; i < S; i++) {
      const k = j * S + i;
      const cv = cov[k];
      if (cv <= 0) continue;
      const kl = i > 0 ? k - 1 : k;
      const kr = i < S - 1 ? k + 1 : k;
      const ku = j > 0 ? k - S : k;
      const kd = j < S - 1 ? k + S : k;
      const dzdx = (h[kr] - h[kl]) * (kr - kl === 2 ? inv2 : inv1);
      const dzdy = (h[kd] - h[ku]) * (kd - ku === S + S ? inv2 : inv1);
      let nx = -dzdx;
      let ny = -dzdy;
      let nz = 1;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= il;
      ny *= il;
      nz *= il;

      const M = mats[mid[k]] ?? mats[0];
      let ar = alb[k * 3];
      let ag = alb[k * 3 + 1];
      let ab = alb[k * 3 + 2];

      // Thick-path absorption: saturate toward grazing angles.
      const dk = (1 - nz) * M.deepen;
      ar = ar * (1 - dk + dk * ar);
      ag = ag * (1 - dk + dk * ag);
      ab = ab * (1 - dk + dk * ab);

      // Cavity occlusion.
      let ao = 1;
      if (hb) {
        const cav = hb[k] - h[k];
        if (cav > 0) ao = 1 - clamp01(cav * aoK) * 0.75;
      }

      // Diffuse: wrapped key + hemispheric ambient.
      const ndl = nx * KX + ny * KY + nz * KZ;
      const wrap = ndl > -0.3 ? (ndl + 0.3) / 1.3 : 0;
      const amb = M.amb * (0.8 - 0.25 * ny);
      const dif = (M.diff * wrap + amb) * ao;

      // Subsurface: key light entering upper-left refracts through the body and
      // pools as a warm backlit glow inside the lower-right, plus thin edges.
      const lr = nx * 0.55 + ny * 0.83;
      const lrk = lr > 0 ? lr * Math.sqrt(lr) : 0;
      const thin = 1 - clamp01(h[k] * 2.2);
      const pxp = (i + 0.5) * px - 1;
      const lrp = clamp01(((pxp * 0.55 + py * 0.83) + 0.05) / 0.7);
      const caus = lrp * lrp * (3 - 2 * lrp) * clamp01(h[k] * 4);
      const sssK = M.sss * (0.62 * lrk + 0.42 * thin * thin + 0.38 * caus + 0.12) * (0.55 + 0.45 * ao);

      // Fresnel.
      const fm = 1 - nz;
      const f4 = fm * fm * fm * fm;
      const F = M.f0 + (1 - M.f0) * f4;

      // Mirror reflection of the studio.
      const ndv2 = 2 * nz;
      const rx = ndv2 * nx;
      const ry = ndv2 * ny;
      const rz = ndv2 * nz - 1;
      env(rx, ry, rz);
      const rk = F * M.spec * (0.65 + 0.35 * ao);

      // Dual Blinn-Phong lobes.
      const nhRaw = nx * HKX + ny * HKY + nz * HKZ;
      const nh = nhRaw > 0 ? nhRaw : 0;
      const n3 = nh * nh * nh;
      const n6 = n3 * n3;
      const n12 = n6 * n6;
      const n24 = n12 * n12;
      // nh^128 from n24 is wasteful; square up from nh^64 instead.
      let sh = n24 * n24 * n12 * n6 * n3 * nh; // nh^64 (24+24+12+3+1 = 64)
      if (M.sharpSq >= 7) sh *= sh; // 128
      if (M.sharpSq >= 8) sh *= sh; // 256
      if (M.sharpSq < 6) sh = n24 * n6; // ~30 for satin-only sheens
      const nh2Raw = nx * HRX + ny * HRY + nz * HRZ;
      const nh2 = nh2Raw > 0 ? nh2Raw : 0;
      let r64 = nh2 * nh2;
      r64 *= r64;
      r64 *= r64;
      r64 *= r64;
      r64 *= r64;
      r64 *= r64;
      // Pinpoint sparkle: nh^512, only on glossy materials.
      let pin = 0;
      if (M.sharpSq >= 8) {
        const npRaw = nx * HPX + ny * HPY + nz * HPZ;
        if (npRaw > 0.98) {
          let q = npRaw;
          for (let t = 0; t < 9; t++) q *= q; // ^512
          pin = q * M.sharp * 1.9;
        }
      }
      const lob = (M.broad * n24 * 0.55 + M.sharp * sh * 2.0 + pin) * (0.4 + 0.6 * ao);
      const lobR = M.broad * r64 * 0.5;

      const rimK = M.rim * f4;
      const em = emis[k];

      const kd2 = 1 - F;
      const specR = E[0] * rk + lob + lobR * 0.85 + rimK * M.rimC[0] + em;
      const specG = E[1] * rk + lob * 0.985 + lobR * 0.93 + rimK * M.rimC[1] + em;
      const specB = E[2] * rk + lob * 0.95 + lobR + rimK * M.rimC[2] + em;
      const op = M.op;
      let cr = op * (ar * dif * kd2 + M.sssC[0] * ar * sssK + ar * sssK * 0.35) + specR;
      let cg = op * (ag * dif * kd2 + M.sssC[1] * ag * sssK + ag * sssK * 0.35) + specG;
      let cb = op * (ab * dif * kd2 + M.sssC[2] * ab * sssK + ab * sssK * 0.35) + specB;

      // Highlights bleed toward white.
      const lum = (cr + cg + cb) * 0.3333;
      if (lum > 0.82) {
        const w = (lum - 0.82) * 0.65;
        cr += w;
        cg += w;
        cb += w;
      }
      cr = tone(cr);
      cg = tone(cg);
      cb = tone(cb);

      let a = 1;
      if (op < 1) {
        const sl = (specR + specG + specB) * 0.3333;
        a = clamp01(op + sl * 0.9);
      }
      const q4 = k * 4;
      col[q4] = cr * cv;
      col[q4 + 1] = cg * cv;
      col[q4 + 2] = cb * cv;
      col[q4 + 3] = a * cv;

      if (sheen && M.sheen > 0) {
        // Diagonal streak light for the glint sweep.
        const sd = (rx + ry) * 0.7071 + 0.42;
        const b1 = 1 - (sd * sd) / 0.03;
        const s2 = sd - 0.3;
        const b2 = 1 - (s2 * s2) / 0.01;
        const band = (b1 > 0 ? b1 * b1 : 0) + (b2 > 0 ? 0.35 * b2 * b2 : 0);
        const gI = band * (0.3 + 0.7 * F + 0.4 * fm) * M.sheen * cv * (rz > -0.5 ? 1 : 0.3);
        if (gI > 0.002) {
          const gi = gI > 1 ? 1 : gI;
          sheen[q4] = gi;
          sheen[q4 + 1] = gi * 0.98;
          sheen[q4 + 2] = gi * 0.94;
          sheen[q4 + 3] = gi;
        }
      }
    }
  }
  return { col, sheen };
}

/** Candy-tinted contact shadow with a warm caustic core, as premultiplied RGBA. */
function contactShadow(cov: Float32Array, S: number, o: { dx: number; dy: number; r: number; a: number; deep: RGB; caustic: RGB; ck: number }): Float32Array {
  const b = blur(cov, S, S * o.r);
  const out = new Float32Array(S * S * 4);
  const ox = Math.round(o.dx * S);
  const oy = Math.round(o.dy * S);
  for (let j = 0; j < S; j++) {
    const sj = j - oy;
    if (sj < 0 || sj >= S) continue;
    for (let i = 0; i < S; i++) {
      const si = i - ox;
      if (si < 0 || si >= S) continue;
      const v = b[sj * S + si];
      if (v <= 0.002) continue;
      const a = v * o.a;
      const c = smoothstep(0.45, 0.95, v) * o.ck;
      const k = (j * S + i) * 4;
      out[k] = (o.deep[0] + (o.caustic[0] - o.deep[0]) * c) * a;
      out[k + 1] = (o.deep[1] + (o.caustic[1] - o.deep[1]) * c) * a;
      out[k + 2] = (o.deep[2] + (o.caustic[2] - o.deep[2]) * c) * a;
      out[k + 3] = a;
    }
  }
  return out;
}

/** Soft radial aura (premultiplied). */
function aura(S: number, cx: number, cy: number, sigma: number, a: number, c: RGB): Float32Array {
  const out = new Float32Array(S * S * 4);
  const px = 2 / S;
  const inv = 1 / (sigma * sigma);
  for (let j = 0; j < S; j++) {
    const y = (j + 0.5) * px - 1 - cy;
    for (let i = 0; i < S; i++) {
      const x = (i + 0.5) * px - 1 - cx;
      const r2 = (x * x + y * y) * inv;
      if (r2 > 6) continue;
      const v = Math.exp(-r2) * a;
      const k = (j * S + i) * 4;
      out[k] = c[0] * v;
      out[k + 1] = c[1] * v;
      out[k + 2] = c[2] * v;
      out[k + 3] = v;
    }
  }
  return out;
}

/** dst = src over dst (premultiplied, in place). */
function over(dst: Float32Array, src: Float32Array): void {
  for (let k = 0; k < dst.length; k += 4) {
    const a = src[k + 3];
    if (a <= 0 && src[k] <= 0 && src[k + 1] <= 0 && src[k + 2] <= 0) continue;
    const ia = 1 - (a > 1 ? 1 : a);
    dst[k] = src[k] + dst[k] * ia;
    dst[k + 1] = src[k + 1] + dst[k + 1] * ia;
    dst[k + 2] = src[k + 2] + dst[k + 2] * ia;
    dst[k + 3] = (a > 1 ? 1 : a) + dst[k + 3] * ia;
  }
}

function toBytes(p: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(p.length);
  for (let k = 0; k < p.length; k += 4) {
    const a = p[k + 3];
    if (a <= 0.001) continue;
    const inv = 255 / a;
    out[k] = p[k] * inv;
    out[k + 1] = p[k + 1] * inv;
    out[k + 2] = p[k + 2] * inv;
    out[k + 3] = a * 255;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Palettes                                                                    */
/* -------------------------------------------------------------------------- */

interface Pal {
  base: RGB;
  light: RGB;
  deep: RGB;
  sss: RGB;
  glow: RGB;
}

const PAL: Record<PbrCandyColor | 'none', Pal> = {
  red: { base: [0.9, 0.04, 0.17], light: [1, 0.58, 0.62], deep: [0.36, 0.0, 0.07], sss: [1, 0.36, 0.3], glow: [1, 0.32, 0.36] },
  orange: { base: [1, 0.47, 0.04], light: [1, 0.86, 0.55], deep: [0.55, 0.15, 0.0], sss: [1, 0.74, 0.3], glow: [1, 0.66, 0.25] },
  yellow: { base: [1, 0.8, 0.1], light: [1, 0.97, 0.7], deep: [0.72, 0.42, 0.0], sss: [1, 0.93, 0.48], glow: [1, 0.88, 0.35] },
  green: { base: [0.12, 0.76, 0.26], light: [0.75, 1, 0.7], deep: [0.0, 0.27, 0.08], sss: [0.68, 1, 0.42], glow: [0.5, 1, 0.5] },
  blue: { base: [0.05, 0.3, 0.92], light: [0.7, 0.88, 1], deep: [0.01, 0.06, 0.38], sss: [0.35, 0.92, 1], glow: [0.3, 0.85, 1] },
  purple: { base: [0.64, 0.25, 0.98], light: [0.94, 0.78, 1], deep: [0.24, 0.03, 0.45], sss: [1, 0.62, 1], glow: [0.86, 0.56, 1] },
  none: { base: [0.93, 0.88, 1], light: [1, 1, 1], deep: [0.4, 0.32, 0.55], sss: [1, 0.95, 1], glow: [1, 0.92, 0.7] },
};

const SPRINKLES: RGB[] = ['#ff3d64', '#ff9a26', '#ffe14d', '#46e07e', '#3ca2ff', '#c070ff', '#ffffff', '#ff86cc'].map(hexRGB);

function set(s: Sample, c: RGB, m = 0): void {
  s.r = c[0];
  s.g = c[1];
  s.b = c[2];
  s.m = m;
}

/* -------------------------------------------------------------------------- */
/* Candy geometry                                                              */
/* -------------------------------------------------------------------------- */

const CY = -0.05; // lift bodies a touch so the contact shadow has room

/** Ruby jelly bean: plump kidney dome with a pinched top contour. */
function beanFn(p: Pal): SampleFn {
  const a = -0.32;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return (x, y, s) => {
    const yy = y - CY;
    const u = x * ca + yy * sa;
    const v = -x * sa + yy * ca;
    let d = sdEllipse(u, v, 0.82, 0.52);
    const notch = len2(u, v + 0.84) - 0.42;
    d = smax(d, -notch, 0.16);
    s.d = d;
    if (d > 0.04) return;
    s.h = inflate(-d, 0.48) * 1.02;
    set(s, p.base);
  };
}

/**
 * Tangerine oval lozenge: a smooth, tilted citrus hard-candy drop. One
 * continuous pillowy dome (no facets or polygon edges) so the softbox slides
 * across it as a single sweeping curved mirror sheen.
 */
function lozengeFn(p: Pal): SampleFn {
  const a = -0.31; // ~-18°: the long axis leans up to the right
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const A = 0.82;
  const B = 0.6;
  return (x, y, s) => {
    const yy = y - CY;
    const u = x * ca + yy * sa;
    const v = -x * sa + yy * ca;
    const d = sdEllipse(u, v, A, B);
    s.d = d;
    if (d > 0.04) return;
    const q = 1 - (u * u) / (A * A) - (v * v) / (B * B);
    // Rounded bevel at the rim blended into a broad ellipsoid crown.
    s.h = inflate(-d, 0.36) * 0.78 + 0.22 * (q > 0 ? Math.sqrt(q) : 0);
    set(s, p.base);
  };
}

/**
 * Classic lemon drop: a plump pear/teardrop hard candy. A lush round base
 * flows up into a soft rounded droplet tip leaning toward the upper right.
 */
function lemonDropFn(p: Pal): SampleFn {
  const a = 0.36; // tip leans ~20° clockwise from straight up
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const R1 = 0.6;
  const R2 = 0.27;
  const HG = 0.64;
  // Centre the drop's extent ([-R1, HG + R2] along its axis) on the sprite.
  const BY = 0.15; // base centre sits this far below the sprite centre (y-down)
  return (x, y, s) => {
    const dx = x - 0.02;
    const dy = y - CY - BY;
    // Axis-local coords: v runs up the drop toward the tip (y-up).
    const u = dx * ca + dy * sa;
    const v = dx * sa - dy * ca;
    // Soft-union the drop with its base so the shoulders swell into a pear.
    const d = smin(sdTeardrop(u, v, R1, R2, HG), len2(u, v + 0.02) - R1 * 1.02, 0.12);
    s.d = d;
    if (d > 0.04) return;
    // Plump circular-profile body, extra crown over the bulbous base.
    const rb = (u * u + (v - 0.1) * (v - 0.1)) / (R1 * R1);
    s.h = inflate(-d, 0.42) * 0.98 + 0.12 * Math.max(0, 1 - rb);
    set(s, p.base);
  };
}

/**
 * Lime gummy pillow: a puffed, squishy cushion with gently bowed convex sides
 * and soft corners, domed continuously all the way across the middle.
 */
function pillowFn(p: Pal): SampleFn {
  const a = 0.07; // a hint of tilt so it never reads as a rigid UI tile
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const R = 0.76;
  return (x, y, s) => {
    const yy = y - CY;
    const u = x * ca + yy * sa;
    const v = -x * sa + yy * ca;
    const d = sdSquircle(u, v, R, 2.9);
    s.d = d;
    if (d > 0.04) return;
    const du = Math.max(0, 1 - (u / R) * (u / R));
    const dv = Math.max(0, 1 - (v / R) * (v / R));
    // Soft rolled edge + a continuous stuffed crown (no plateau).
    s.h = inflate(-d, 0.26) * 0.7 + 0.34 * Math.sqrt(du * dv);
    set(s, p.base);
  };
}

/**
 * Blueberry hard-candy drop: a plump glossy sphere with a shallow sculpted
 * swirl dimple, tone-on-tone cobalt to cerulean (never white, so striped
 * candies stay unmistakable).
 */
function orbFn(p: Pal, swirl: boolean): SampleFn {
  const R = 0.76;
  const cer: RGB = [0.16, 0.62, 1.0];
  const DX = 0.04;
  const DY = 0.03;
  return (x, y, s) => {
    const yy = y - CY;
    const rr = x * x + yy * yy;
    const d = Math.sqrt(rr) - R;
    s.d = d;
    if (d > 0.04) return;
    const z = Math.sqrt(Math.max(0, R * R - rr));
    s.h = z;
    set(s, p.base);
    if (!swirl) return;
    // Pinwheel swirl spiralling into a shallow pressed dimple near the crown.
    const sx = x - DX;
    const sy = yy - DY;
    const r = len2(sx, sy);
    const phi = Math.atan2(sy, sx);
    const f = Math.sin(phi * 3 + r * 7);
    const fade = smoothstep(0.06, 0.26, r) * (1 - smoothstep(0.46, 0.72, r));
    const w = (0.5 + 0.5 * f) * fade;
    s.r = p.base[0] + (cer[0] - p.base[0]) * w * 0.72;
    s.g = p.base[1] + (cer[1] - p.base[1]) * w * 0.72;
    s.b = p.base[2] + (cer[2] - p.base[2]) * w * 0.72;
    s.h = z + 0.01 * f * fade - 0.032 * Math.exp(-(r * r) / 0.05);
  };
}

/** Amethyst bonbon cluster: grape lobes fused with smooth-min. */
function clusterFn(p: Pal): SampleFn {
  // Flat [x, y, r, z0] per lobe: one raised centre grape ringed by seven.
  const L = [0, -0.03, 0.33, 0.2];
  for (let k = 0; k < 7; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 7 + 0.2;
    L.push(Math.cos(a) * 0.47, Math.sin(a) * 0.45, 0.29, 0.02);
  }
  const N = L.length;
  return (x, y, s) => {
    const yy = y - CY;
    const rr = x * x + yy * yy;
    if (rr > 0.86 * 0.86) {
      s.d = Math.sqrt(rr) - 0.78;
      return;
    }
    let d = 9;
    let h = -9;
    for (let q = 0; q < N; q += 4) {
      const lr = L[q + 2];
      const lz = L[q + 3];
      const dist = len2(x - L[q], yy - L[q + 1]);
      d = smin(d, dist - lr, 0.045);
      const hi = dist < lr ? lz + Math.sqrt(lr * lr - dist * dist) : lz - (dist - lr) * 2.5;
      h = smax(h, hi, 0.05);
    }
    s.d = d;
    if (d > 0.04) return;
    s.h = Math.max(0, h);
    set(s, p.base);
  };
}

function regularFn(color: PbrCandyColor | 'none', swirl = true): SampleFn {
  const p = PAL[color];
  switch (color) {
    case 'red':
      return beanFn(p);
    case 'orange':
      return lozengeFn(p);
    case 'yellow':
      return lemonDropFn(p);
    case 'green':
      return pillowFn(p);
    case 'blue':
      return orbFn(p, swirl);
    case 'purple':
      return clusterFn(p);
    default:
      return orbFn(p, false);
  }
}

function candyMats(color: PbrCandyColor | 'none'): Mat[] {
  const p = PAL[color];
  // Wet sugar glaze: strong mirror, generous backlit translucency.
  const body = mat({ sssC: p.sss, rimC: p.light, sss: 0.9, rim: 0.5, spec: 1.15 });
  switch (color) {
    case 'red':
      body.sss = 1.0;
      break;
    case 'orange':
      body.spec = 1.25;
      body.sss = 1.05;
      body.deepen = 0.5;
      break;
    case 'yellow':
      body.sss = 1.05;
      body.deepen = 0.55;
      break;
    case 'green':
      body.sss = 1.05;
      body.deepen = 0.6;
      break;
    case 'blue':
      body.spec = 1.3;
      body.sss = 0.95;
      break;
    case 'purple':
      body.sss = 1.05;
      break;
  }
  const enamel = mat({ sss: 0.25, sssC: [1, 0.95, 0.92], deepen: 0.12, broad: 0.55, sharp: 1.8, rim: 0.3 });
  return [body, enamel];
}

/** Sugar-enamel stripes mapped onto the candy's curved height field. */
function stripedFn(base: SampleFn, orient: 'h' | 'v'): SampleFn {
  const period = 0.27;
  const white: RGB = [1, 0.985, 0.97];
  return (x, y, s) => {
    base(x, y, s);
    if (s.d > 0.04) return;
    const a = orient === 'h' ? y - CY : x;
    const b = orient === 'h' ? x : y - CY;
    // Bend the band along the dome: compress over the crown, sag at the sides.
    const c = a * (1 + 0.45 * s.h) + 0.14 * b * b;
    const t = c / period + 0.5;
    const dd = Math.abs(t - Math.floor(t) - 0.5);
    const w = smoothstep(0.255, 0.215, dd);
    if (w <= 0) return;
    s.r += (white[0] - s.r) * w;
    s.g += (white[1] - s.g) * w;
    s.b += (white[2] - s.b) * w;
    s.h += 0.028 * w;
    s.e *= 1 - w;
    if (w > 0.5) s.m = 1;
  };
}

function scaled(fn: SampleFn, k: number, ox = 0, oy = 0): SampleFn {
  return (x, y, s) => {
    fn((x - ox) / k, (y - oy) / k, s);
    s.d *= k;
    s.h *= k;
  };
}

/** Crinkled cellophane: clear pillow film with ruffled, pinched twist ears. */
function wrapperFn(p: Pal): SampleFn {
  const r = rng(911);
  const folds: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI;
    folds.push([(r() - 0.5) * 0.9, (r() - 0.5) * 0.9, Math.cos(a), Math.sin(a), (r() < 0.5 ? -1 : 1) * (0.025 + r() * 0.03)]);
  }
  const tint: RGB = [0.94 + 0.06 * p.light[0], 0.94 + 0.06 * p.light[1], 0.94 + 0.06 * p.light[2]];
  return (x, y, s) => {
    const yy = y - CY;
    const dP = sdRoundBox(x, yy, 0.6, 0.6, 0.27);
    const ax = Math.abs(x);
    const u = ax - 0.57;
    const flare = 0.07 + Math.max(0, u) * 0.95;
    const edge = 0.35 + 0.028 * Math.sin(yy * 44);
    const dEar = Math.max(-u, u - edge, Math.abs(yy) - flare);
    const dKnot = len2(ax - 0.6, yy) - 0.085;
    const d = smin(smin(dP, dEar, 0.04), dKnot, 0.03);
    s.d = d;
    if (d > 0.04) return;
    if (dP < 0.0 && dP <= dEar) {
      let h = inflate(-dP, 0.24) * 1.1;
      for (let q = 0; q < folds.length; q++) {
        const f = folds[q];
        const dist = Math.abs((x - f[0]) * f[3] - (yy - f[1]) * f[2]);
        if (dist < 0.07) h += f[4] * (1 - dist / 0.07);
      }
      s.h = h;
      set(s, tint, 0);
    } else {
      // Fan pleats radiating from the pinch: sharp folded mirror ridges.
      const pu = Math.max(0, u);
      const ang = yy / (0.08 + pu);
      const pleat = Math.abs(Math.sin(ang * 3.2));
      s.h = 0.07 + 0.11 * (1 - Math.min(1, pu / 0.36)) + 0.05 * pleat * Math.min(1, pu * 6) + inflate(-d, 0.05);
      const k = 0.55 + 0.45 * pleat;
      s.r = p.light[0] * k + p.base[0] * (1 - k);
      s.g = p.light[1] * k + p.base[1] * (1 - k);
      s.b = p.light[2] * k + p.base[2] * (1 - k);
      s.m = 1;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Sugar Bee (homing seeker)                                                   */
/* -------------------------------------------------------------------------- */

// The bee's local frame: body centre and a slight nose-up tilt so the tail dips.
const BEE_X = 0.02;
const BEE_Y = 0.12;
const BEE_TILT = 0.12;
const BEE_CA = Math.cos(BEE_TILT);
const BEE_SA = Math.sin(BEE_TILT);

/** Honey stripe colour that always contrasts with the candy body. */
function beeStripe(color: PbrCandyColor | 'none'): RGB {
  if (color === 'yellow') return [0.4, 0.17, 0.03]; // a real bee: dark amber on gold
  if (color === 'orange') return [1, 0.9, 0.55]; // pale honey cream on tangerine
  return [1, 0.74, 0.14]; // warm golden honey
}

/**
 * Plump teardrop glass-candy bee: big round head end with glossy eyes, blush
 * and a smile, golden honey belly bands wrapped over the dome, a honey stinger
 * and two bobble antennae.
 */
function beeBodyFn(color: PbrCandyColor | 'none'): SampleFn {
  const p = PAL[color];
  const stripeC = beeStripe(color);
  const stingC: RGB = [0.52, 0.27, 0.05];
  const stalkC: RGB = [0.3, 0.12, 0.04];
  const eyeC: RGB = [0.05, 0.02, 0.07];
  const blushC: RGB = [1, 0.56, 0.66];
  const smileC: RGB = [0.28, 0.06, 0.1];
  const ants = [quadPts(-0.52, -0.22, -0.74, -0.42, -0.86, -0.36, 8), quadPts(-0.4, -0.3, -0.56, -0.56, -0.72, -0.58, 8)];
  const antBox = ants.map((pts) => {
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return [Math.min(...xs) - 0.1, Math.min(...ys) - 0.1, Math.max(...xs) + 0.1, Math.max(...ys) + 0.1];
  });
  const EYES: ReadonlyArray<readonly [number, number]> = [
    [-0.43, -0.02],
    [-0.21, 0.04],
  ];
  const BLUSH: ReadonlyArray<readonly [number, number]> = [
    [-0.53, 0.16],
    [-0.11, 0.21],
  ];
  const ER = 0.08;
  const AW = 0.028;
  const AB = 0.07;
  return (x, y, s) => {
    const dx = x - BEE_X;
    const dy = y - BEE_Y;
    const u = dx * BEE_CA + dy * BEE_SA;
    const v = -dx * BEE_SA + dy * BEE_CA;
    const r2 = u * u + v * v;
    if (r2 > 1.2) {
      s.d = Math.sqrt(r2) - 1.04;
      return;
    }
    // Teardrop: an ellipse whose half-height tapers toward the tail, plus a stinger.
    const taper = 1 - 0.3 * smoothstep(-0.3, 0.75, u);
    const dB = sdEllipse(u, v / taper, 0.7, 0.5) * taper;
    const sr = 0.06 - 0.045 * clamp01((u - 0.58) / 0.3);
    const dS = segDist(u, v, 0.58, 0.02, 0.88, 0.06) - sr;
    const dBody = smin(dB, dS, 0.05);
    let d = dBody;
    let h = dBody < 0 ? inflate(-dBody, 0.46) : 0;
    let part = 0; // 0 body, 1 antenna stalk, 2 antenna bobble
    for (let q = 0; q < ants.length; q++) {
      const bb = antBox[q];
      if (u < bb[0] || u > bb[2] || v < bb[1] || v > bb[3]) continue;
      const pts = ants[q];
      for (let i = 0; i < pts.length - 1; i++) {
        const dist = segDist(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (dist - AW < d) d = dist - AW;
        if (dist < AW) {
          const hh = 0.36 - 0.1 * clamp01((-u - 0.4) / 0.46) + Math.sqrt(AW * AW - dist * dist);
          if (hh > h) {
            h = hh;
            part = 1;
          }
        }
      }
      const end = pts[pts.length - 1];
      const de = len2(u - end[0], v - end[1]);
      if (de - AB < d) d = de - AB;
      if (de < AB) {
        const hh = 0.3 + Math.sqrt(AB * AB - de * de);
        if (hh > h) {
          h = hh;
          part = 2;
        }
      }
    }
    s.d = d;
    if (d > 0.04) return;
    s.h = h;
    if (part === 1) {
      set(s, stalkC, 1);
      return;
    }
    if (part === 2) {
      set(s, p.base, 0);
      return;
    }
    if (dS < dB) {
      set(s, stingC, 1);
      return;
    }
    set(s, p.base, 0);
    // Honey belly bands, bowed over the dome toward the tail.
    const c = u * (1 + 0.4 * h) + 0.12 * v * v;
    const t = (c - 0.06) / 0.25;
    const k = Math.round(t);
    if (k >= 0 && k <= 2) {
      const w = smoothstep(0.27, 0.2, Math.abs(t - k));
      if (w > 0) {
        s.r += (stripeC[0] - s.r) * w;
        s.g += (stripeC[1] - s.g) * w;
        s.b += (stripeC[2] - s.b) * w;
        s.h += 0.018 * w;
        if (w > 0.5) s.m = 1;
      }
    }
    // Rosy cheeks.
    for (const b of BLUSH) {
      const wb = smoothstep(0.09, 0.025, len2(u - b[0], v - b[1])) * 0.42;
      if (wb > 0) {
        s.r += (blushC[0] - s.r) * wb;
        s.g += (blushC[1] - s.g) * wb;
        s.b += (blushC[2] - s.b) * wb;
      }
    }
    // Little smile between the eyes.
    const sx = u + 0.32;
    const sy = v - 0.09;
    if (sy > 0.02) {
      const ds = Math.abs(len2(sx, sy) - 0.075);
      if (ds < 0.016) {
        const ws = smoothstep(0.016, 0.006, ds);
        s.r += (smileC[0] - s.r) * ws;
        s.g += (smileC[1] - s.g) * ws;
        s.b += (smileC[2] - s.b) * ws;
        s.h -= 0.008 * ws;
      }
    }
    // Glossy domed eyes with a softbox catchlight.
    for (const e of EYES) {
      const de = len2(u - e[0], v - e[1]);
      if (de >= ER) continue;
      const we = smoothstep(ER, ER - 0.014, de);
      s.h += Math.sqrt(ER * ER - de * de) * 0.55;
      s.r += (eyeC[0] - s.r) * we;
      s.g += (eyeC[1] - s.g) * we;
      s.b += (eyeC[2] - s.b) * we;
      if (we > 0.5) s.m = 2;
      const dc = len2(u - e[0] + 0.026, v - e[1] + 0.03);
      if (dc < 0.026) s.e = Math.max(s.e, (1 - dc / 0.026) * 1.3);
    }
  };
}

/** Two translucent iridescent glass wings in a V over the bee's back. */
function beeWingsFn(color: PbrCandyColor | 'none'): SampleFn {
  const p = PAL[color];
  const WINGS: ReadonlyArray<readonly [number, number, number, number, number]> = [
    // cx, cy, angle, a, b (bee-local)
    [-0.1, -0.5, 0.55, 0.34, 0.17],
    [0.22, -0.48, -0.55, 0.3, 0.15],
  ];
  const trig = WINGS.map((w) => [Math.cos(w[2]), Math.sin(w[2])] as const);
  return (x, y, s) => {
    const dx = x - BEE_X;
    const dy = y - BEE_Y;
    const u = dx * BEE_CA + dy * BEE_SA;
    const v = -dx * BEE_SA + dy * BEE_CA;
    if (v > -0.1 || u < -0.75 || u > 0.75) {
      s.d = Math.max(v + 0.1, Math.abs(u) - 0.75, 0.05);
      return;
    }
    let d = 9;
    let h = 0;
    let wu = 0;
    let wv = 0;
    let wa = 1;
    let edge = 9;
    for (let q = 0; q < WINGS.length; q++) {
      const w = WINGS[q];
      const lx = u - w[0];
      const ly = v - w[1];
      const au = lx * trig[q][0] + ly * trig[q][1];
      const av = -lx * trig[q][1] + ly * trig[q][0];
      const di = sdEllipse(au, av, w[3], w[4]);
      if (di < d) d = di;
      if (di < 0) {
        const hh = 0.08 + inflate(-di, 0.09) * 0.8 + 0.04 * q;
        if (hh > h) {
          h = hh;
          wu = au;
          wv = av;
          wa = w[3];
          edge = -di;
        }
      }
    }
    s.d = d;
    if (d > 0.04) return;
    s.h = h;
    // Soap-bubble iridescence drifting across the membrane, tinted by the candy.
    const f = 0.9 * (wu / wa) + 1.6 * wv + 2.2 * Math.min(edge, 0.12);
    const tau = Math.PI * 2;
    const ir = 0.78 + 0.22 * Math.cos(tau * f);
    const ig = 0.78 + 0.22 * Math.cos(tau * (f - 0.33));
    const ib = 0.8 + 0.2 * Math.cos(tau * (f - 0.67));
    s.r = ir * 0.72 + p.light[0] * 0.28;
    s.g = ig * 0.72 + p.light[1] * 0.28;
    s.b = ib * 0.72 + p.light[2] * 0.28;
    s.m = 0;
    // Fine glass veins and a lit leading edge.
    const vein = Math.abs(wv - 0.18 * wa * (wu / wa) * (wu / wa));
    const vein2 = Math.abs(wv + 0.35 * (wu - wa * 0.1));
    let e = 0.16 * smoothstep(0.012, 0.003, vein) + 0.1 * smoothstep(0.01, 0.002, vein2) * smoothstep(-0.3 * wa, 0.2 * wa, wu);
    e += 0.32 * smoothstep(0.03, 0.004, edge);
    s.e = e;
  };
}

function beeBodyMats(color: PbrCandyColor | 'none'): Mat[] {
  const p = PAL[color];
  return [
    mat({ sssC: p.sss, rimC: p.light, sss: 0.8, rim: 0.5, spec: 1.3, sharp: 2.1, broad: 0.5, deepen: 0.6 }),
    mat({ spec: 1.25, f0: 0.07, broad: 0.55, sharp: 2, sss: 0.85, sssC: [1, 0.78, 0.3], rim: 0.4, rimC: [1, 0.92, 0.65], deepen: 0.45 }),
    mat({ spec: 1.6, f0: 0.08, broad: 0.6, sharp: 2.6, sss: 0.05, rim: 0.3, rimC: [0.8, 0.85, 1], deepen: 0.1, diff: 0.5 }),
  ];
}

function bakeSeeker(color: PbrCandyColor | 'none', S: number): PbrBakeResult {
  const p = PAL[color];
  const body = raster(S, beeBodyFn(color));
  const wings = raster(S, beeWingsFn(color));
  const wingMat = mat({ op: 0.24, spec: 1.5, f0: 0.08, sss: 0.15, sssC: p.light, broad: 0.6, sharp: 2.4, rim: 0.85, rimC: [0.9, 0.95, 1], deepen: 0, diff: 0.55, amb: 0.5, sheen: 1.3 });
  const out = aura(S, 0, BEE_Y - 0.12, 0.72, 0.36, p.glow);
  const shCov = new Float32Array(S * S);
  for (let i = 0; i < shCov.length; i++) {
    const w = wings.cov[i] * 0.3;
    shCov[i] = body.cov[i] > w ? body.cov[i] : w;
  }
  over(out, shadowFor(shCov, S, p, 0.4));
  const cb = shade(body, beeBodyMats(color), { sheen: true, ns: 1.05 });
  const cw = shade(wings, [wingMat], { sheen: true, ao: 0 });
  over(out, cb.col);
  over(out, cw.col);
  let sheen = cb.sheen;
  if (sheen && cw.sheen) over(sheen, cw.sheen);
  else sheen = sheen ?? cw.sheen;
  return finish(S, out, sheen);
}

/* -------------------------------------------------------------------------- */
/* Specials & ingredients                                                      */
/* -------------------------------------------------------------------------- */

interface Sprinkle {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  w: number;
  c: RGB;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function makeSprinkles(R: number): Sprinkle[] {
  const r = rng(4242);
  const out: Sprinkle[] = [];
  const pts: Array<[number, number, number]> = [];
  let tries = 0;
  while (out.length < 26 && tries < 900) {
    tries++;
    const z = 0.22 + r() * 0.78;
    const a = r() * Math.PI * 2;
    const q = Math.sqrt(1 - z * z);
    const p: [number, number, number] = [Math.cos(a) * q, Math.sin(a) * q, z];
    if (pts.some((o) => o[0] * p[0] + o[1] * p[1] + o[2] * p[2] > 0.955)) continue;
    pts.push(p);
    // Random tangent direction.
    const ta = r() * Math.PI * 2;
    let tx = Math.cos(ta);
    let ty = Math.sin(ta);
    let tz = 0;
    const dp = tx * p[0] + ty * p[1] + tz * p[2];
    tx -= dp * p[0];
    ty -= dp * p[1];
    tz -= dp * p[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const L = 0.115;
    const cx = p[0] * R;
    const cy = p[1] * R + CY;
    const ax = cx - (tx / tl) * L * R;
    const ay = cy - (ty / tl) * L * R;
    const bx = cx + (tx / tl) * L * R;
    const by = cy + (ty / tl) * L * R;
    const w = 0.042 * (0.55 + 0.45 * Math.sqrt(z));
    out.push({ ax, ay, bx, by, w, c: SPRINKLES[out.length % SPRINKLES.length], x0: Math.min(ax, bx) - w - 0.06, y0: Math.min(ay, by) - w - 0.06, x1: Math.max(ax, bx) + w + 0.06, y1: Math.max(ay, by) + w + 0.06 });
  }
  return out;
}

/** Mirror-glazed chocolate truffle studded with raised rainbow sprinkles. */
function bombFn(): SampleFn {
  const R = 0.76;
  const choc: RGB = [0.27, 0.12, 0.055];
  const spr = makeSprinkles(R);
  const shx = 0.03;
  const shy = 0.042;
  return (x, y, s) => {
    const yy = y - CY;
    const rr = x * x + yy * yy;
    const d = Math.sqrt(rr) - R;
    s.d = d;
    if (d > 0.04) return;
    const z = Math.sqrt(Math.max(0, R * R - rr));
    s.h = z;
    set(s, choc, 0);
    let shadow = 0;
    for (const p of spr) {
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue;
      const dist = segDist(x, y, p.ax, p.ay, p.bx, p.by);
      if (dist < p.w) {
        const t = dist / p.w;
        s.h = z + 0.05 * Math.sqrt(1 - t * t) + 0.012;
        set(s, p.c, 1);
        shadow = 0;
        break;
      }
      const ds = segDist(x - shx, y - shy, p.ax, p.ay, p.bx, p.by);
      if (ds < p.w * 1.25) shadow = Math.max(shadow, 1 - ds / (p.w * 1.25));
    }
    if (shadow > 0 && s.m === 0) {
      const k = 1 - 0.6 * shadow;
      s.r *= k;
      s.g *= k;
      s.b *= k;
      s.h -= 0.006 * shadow;
    }
  };
}

function quadPts(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by]);
  }
  return out;
}

/** Twin mirror-gloss cherries, curved stems, leaf and a dewdrop. */
function cherryFn(): SampleFn {
  const red: RGB = [0.86, 0.04, 0.16];
  const stemC: RGB = [0.36, 0.55, 0.12];
  const leafC: RGB = [0.24, 0.66, 0.2];
  const balls: Array<[number, number, number]> = [
    [-0.33, 0.3, 0.37],
    [0.33, 0.26, 0.37],
  ];
  const stems = [quadPts(-0.3, 0.0, -0.26, -0.42, 0.1, -0.74, 10), quadPts(0.31, -0.04, 0.3, -0.42, 0.1, -0.74, 10)];
  const stemBox = stems.map((pts) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - 0.1, Math.min(...ys) - 0.1, Math.max(...xs) + 0.1, Math.max(...ys) + 0.1];
  });
  const la = -0.45;
  const lca = Math.cos(la);
  const lsa = Math.sin(la);
  return (x, y, s) => {
    let d = 9;
    let h = 0;
    let m = 0;
    let c: RGB = red;
    for (let q = 0; q < balls.length; q++) {
      const bx = balls[q][0];
      const by = balls[q][1];
      const br = balls[q][2];
      const dist = len2(x - bx, y - by);
      const dd = dist - br;
      if (dd < d) d = dd;
      if (dist < br) {
        // Dimple where the stem enters.
        const tx = x - bx;
        const ty = y - (by - br * 0.7);
        const hh = Math.sqrt(br * br - dist * dist) - 0.07 * Math.exp(-(tx * tx + ty * ty) / 0.006);
        if (hh > h) {
          h = hh;
          m = 0;
          c = red;
        }
      }
    }
    // Stems (tubes along polylines).
    for (let q = 0; q < stems.length; q++) {
      const pts = stems[q];
      const bb = stemBox[q];
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        const w = 0.045;
        const dist = segDist(x, y, ax, ay, bx, by);
        if (dist - w < d) d = Math.min(d, dist - w);
        if (dist < w) {
          const base = 0.3 - (i / pts.length) * 0.08;
          const hh = base + Math.sqrt(w * w - dist * dist);
          if (hh > h) {
            h = hh;
            m = 1;
            c = stemC;
          }
        }
      }
    }
    // Leaf.
    const lx = x - 0.1;
    const ly = y + 0.74;
    const u = lx * lca + ly * lsa - 0.27;
    const v = -lx * lsa + ly * lca;
    const dl = sdEllipse(u, v, 0.28, 0.12);
    if (dl < d) d = dl;
    if (dl < 0) {
      const hh = 0.28 + inflate(-dl, 0.1) * 0.7 - 0.02 * Math.exp(-(v * v) / 0.0003) + 0.01 * Math.sin(u * 30 + Math.abs(v) * 40);
      if (hh > h) {
        h = hh;
        m = 2;
        c = leafC;
      }
    }
    s.d = d;
    if (d > 0.04) return;
    s.h = h;
    set(s, c, m);
    // Dewdrop on the left cherry.
    const dx = x + 0.2;
    const dy = y - 0.43;
    const dr = len2(dx, dy);
    if (dr < 0.065 && m === 0) {
      s.h = h + Math.sqrt(0.065 * 0.065 - dr * dr) * 0.9;
      s.r = 1;
      s.g = 0.45;
      s.b = 0.5;
      s.m = 3;
    }
  };
}

/** Hazelnut: satin chestnut body with a woven textured cap and stalk. */
function hazelFn(): SampleFn {
  const nut: RGB = [0.62, 0.31, 0.12];
  const cap: RGB = [0.82, 0.6, 0.33];
  const stalk: RGB = [0.45, 0.27, 0.12];
  return (x, y, s) => {
    const dBody = smin(len2(x, y - 0.16) - 0.6, len2(x, y - 0.64) - 0.22, 0.3);
    const capEdge = -0.08 + 0.035 * Math.sin(x * 24);
    const dCap = Math.max(sdEllipse(x, y + 0.3, 0.7, 0.4), y - capEdge);
    const dSt = segDist(x, y, 0, -0.6, 0.04, -0.88) - 0.05;
    const d = Math.min(dBody, dCap, dSt);
    s.d = d;
    if (d > 0.04) return;
    let h = inflate(-dBody, 0.5) * 0.9;
    set(s, nut, 0);
    const grain = 0.9 + 0.1 * Math.sin(x * 22 + 2 * Math.sin(y * 5));
    s.r *= grain;
    s.g *= grain;
    s.b *= grain;
    if (dCap < 0) {
      const weave = (Math.abs(Math.sin(x * 26 + y * 13)) + Math.abs(Math.sin(x * 26 - y * 13))) * 0.5;
      const hc = 0.36 + inflate(-dCap, 0.18) * 0.7 + 0.03 * weave;
      if (hc > h) {
        h = hc;
        const k = 0.8 + 0.25 * weave;
        s.r = cap[0] * k;
        s.g = cap[1] * k;
        s.b = cap[2] * k;
        s.m = 1;
      }
    }
    if (dSt < 0) {
      const t = -dSt / 0.05;
      const hs = 0.55 + 0.05 * Math.sqrt(Math.min(1, t * (2 - t)));
      if (hs > h) {
        h = hs;
        set(s, stalk, 2);
      }
    }
    s.h = h;
  };
}

/* -------------------------------------------------------------------------- */
/* Blockers                                                                    */
/* -------------------------------------------------------------------------- */

/** Piped meringue tiers with ruffled edges, swirl grooves, crystals and cracks. */
function frostingFn(layers: 1 | 2 | 3): SampleFn {
  const icing: RGB = [0.995, 0.975, 0.965];
  const tiers: Array<[number, number, number, number, number]> = [[0.02, 0.86, 0.84, 0.4, 0]];
  if (layers >= 2) tiers.push([-0.1, 0.6, 0.52, 0.3, 0.17]);
  if (layers >= 3) tiers.push([-0.22, 0.34, 0.3, 0.2, 0.33]);
  const cracks: Array<Array<[number, number]>> = [];
  if (layers < 3) {
    const r = rng(layers * 13 + 5);
    const count = layers === 1 ? 3 : 1;
    for (let c = 0; c < count; c++) {
      const side = r() * Math.PI * 2;
      let x = Math.cos(side) * 0.82;
      let y = Math.sin(side) * 0.78;
      let a = side + Math.PI + (r() - 0.5) * 0.6;
      const pts: Array<[number, number]> = [[x, y]];
      for (let k = 0; k < 4; k++) {
        a += (r() - 0.5) * 1.1;
        const len = 0.1 + r() * 0.1;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        pts.push([x, y]);
      }
      cracks.push(pts);
    }
  }
  return (x, y, s) => {
    let d = 9;
    let h = -1;
    // One angle/radius per pixel, shared by every tier's ruffle and swirl groove.
    const by0 = y - 0.02;
    const ang = Math.atan2(by0, x);
    const groove = 0.012 * (0.5 + 0.5 * Math.sin(len2(x, by0 + 0.1) * 34 - ang * 2));
    for (let q = 0; q < tiers.length; q++) {
      const t = tiers[q];
      const base = t[4];
      const yy = y - t[0];
      const box = sdRoundBox(x, yy, t[1], t[2], t[3]);
      if (q === 0 && box > 0.08) {
        s.d = box;
        return;
      }
      if (box > 0.05) continue;
      const dt = box + 0.022 * Math.sin(ang * (14 + q * 2) + base * 9);
      if (d === 9) d = dt;
      if (dt < 0.02) {
        const ht = base + inflate(-dt, 0.24) * 0.72 - groove;
        h = h < 0 ? ht : smax(h, ht, 0.04);
      }
    }
    s.d = d;
    if (d > 0.04) return;
    s.h = Math.max(0, h);
    set(s, icing, 0);
    for (const pts of cracks) {
      let cd = 9;
      for (let i = 0; i < pts.length - 1; i++) cd = Math.min(cd, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
      if (cd < 0.035) {
        // Clean crack: a soft lavender crevice with a lit lip on its far side.
        const g = 1 - cd / 0.035;
        const g2 = g * g;
        s.h -= 0.028 * g2;
        const k = 1 - 0.2 * g2;
        s.r *= k * 0.97;
        s.g *= k * 0.95;
        s.b *= k;
        s.m = 1;
      }
    }
    // Sugar crystals.
    const gx = Math.floor((x + 1) * 16);
    const gy = Math.floor((y + 1) * 16);
    const hv = hash2(gx + layers * 101, gy);
    if (hv < 0.11) {
      const cx = (gx + 0.25 + 0.5 * hash2(gx, gy + 7)) / 16 - 1;
      const cy = (gy + 0.25 + 0.5 * hash2(gx + 3, gy)) / 16 - 1;
      const dr = len2(x - cx, y - cy);
      if (dr < 0.016) s.e = (1 - dr / 0.016) * 0.9;
    }
  };
}

/** Mirror-tempered chocolate block with four beveled pillow squares. */
function chocolateFn(): SampleFn {
  const choc: RGB = [0.33, 0.15, 0.07];
  const deep: RGB = [0.2, 0.08, 0.035];
  return (x, y, s) => {
    const d = sdRoundBox(x, y, 0.9, 0.9, 0.24);
    s.d = d;
    if (d > 0.04) return;
    const slab = inflate(-d, 0.12) * 0.8;
    const qx = Math.abs(x) - 0.43;
    const qy = Math.abs(y) - 0.43;
    const dq = sdRoundBox(qx, qy, 0.35, 0.35, 0.13);
    const pillow = dq < 0 ? 0.08 + inflate(-dq, 0.13) * 0.9 + 0.03 * Math.max(0, 1 - (qx * qx + qy * qy) / 0.12) : 0;
    s.h = Math.max(slab, pillow);
    set(s, pillow > slab ? choc : deep, 0);
  };
}

/** Wet, glassy gelatin tile with a curved liquid surface. */
function jellyFn(layers: 1 | 2): SampleFn {
  const c: RGB = layers === 1 ? [1, 0.5, 0.72] : [0.78, 0.05, 0.33];
  return (x, y, s) => {
    const d = sdRoundBox(x, y, 0.92, 0.92, 0.4);
    s.d = d;
    if (d > 0.04) return;
    s.h = inflate(-d, 0.3) * 0.38 + 0.018 * Math.sin(x * 4.2 + y * 2.6) + 0.012 * Math.sin(y * 7.1 - x * 1.3);
    set(s, c, 0);
  };
}

/** Glossy black-licorice woven lattice with a twisted rope frame. */
function lockedFn(): SampleFn {
  const lic: RGB = [0.11, 0.035, 0.08];
  const o = 0.4;
  const w = 0.105;
  const IS2 = Math.SQRT1_2;
  return (x, y, s) => {
    const clip = sdRoundBox(x, y, 0.93, 0.93, 0.3);
    if (clip > 0.04) {
      s.d = clip;
      return;
    }
    const u = (x + y) * IS2;
    const v = (x - y) * IS2;
    let d = 9;
    let h = 0;
    let along = 0;
    let across = 0;
    // Bars A run along u (at v = ±o), bars B run along v (at u = ±o).
    for (const sg of [-1, 1]) {
      const da = Math.abs(v - sg * o);
      if (da - w < d) d = da - w;
      if (da < w) {
        const base = 0.16 + 0.075 * Math.sin((Math.PI / 2) * (u / o)) * sg;
        const hh = base + Math.sqrt(w * w - da * da);
        if (hh > h) {
          h = hh;
          along = u;
          across = (v - sg * o) / w;
        }
      }
      const db = Math.abs(u - sg * o);
      if (db - w < d) d = db - w;
      if (db < w) {
        const base = 0.16 - 0.075 * Math.sin((Math.PI / 2) * (v / o)) * sg;
        const hh = base + Math.sqrt(w * w - db * db);
        if (hh > h) {
          h = hh;
          along = v;
          across = (u - sg * o) / w;
        }
      }
    }
    // Twisted rope frame.
    const fd = Math.abs(sdRoundBox(x, y, 0.86, 0.86, 0.26)) - 0.065;
    if (fd < d) d = fd;
    if (fd < 0) {
      const t = -fd / 0.065;
      const hh = 0.14 + 0.065 * Math.sqrt(Math.min(1, t * (2 - t)));
      if (hh > h) {
        h = hh;
        along = Math.atan2(y, x) * 1.6;
        across = 1 - t;
      }
    }
    d = Math.max(d, clip);
    s.d = d;
    if (d > 0.04) return;
    const rope = Math.sin(along * 30 + Math.asin(Math.max(-1, Math.min(1, across))) * 3);
    s.h = h + 0.012 * rope;
    const k = 0.85 + 0.3 * (0.5 + 0.5 * rope);
    s.r = lic[0] * k;
    s.g = lic[1] * k;
    s.b = lic[2] * k;
  };
}

/* -------------------------------------------------------------------------- */
/* Bake                                                                        */
/* -------------------------------------------------------------------------- */

function shadowFor(cov: Float32Array, S: number, p: Pal, a = 0.42): Float32Array {
  const deep: RGB = [p.deep[0] * 0.5 + 0.08, p.deep[1] * 0.5 + 0.02, p.deep[2] * 0.5 + 0.08];
  return contactShadow(cov, S, { dx: 0.012, dy: 0.05, r: 0.032, a, deep, caustic: p.glow, ck: 0.55 });
}

function unionCov(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
  return out;
}

interface Body {
  col: Float32Array;
  cov: Float32Array;
  sheen: Float32Array | null;
}

/** Plain lit candy bodies for the current bake size (wrapped candies reuse them). */
const bodyMemo = new Map<string, Body>();
let bodyMemoSize = 0;

function plainBody(color: PbrCandyColor | 'none', S: number): Body {
  if (bodyMemoSize !== S) {
    bodyMemo.clear();
    bodyMemoSize = S;
  }
  const hit = bodyMemo.get(color);
  if (hit) return hit;
  const g = raster(S, regularFn(color));
  const c = shade(g, candyMats(color), { sheen: true, ns: color === 'orange' ? 1 : 1.05 });
  const body: Body = { col: c.col, cov: g.cov, sheen: c.sheen };
  bodyMemo.set(color, body);
  return body;
}

/** Bilinear premultiplied resample: dst(x) = src((x - o) / k), in sprite space. */
function resample(src: Float32Array, S: number, k: number, ox: number, oy: number): Float32Array {
  const out = new Float32Array(S * S * 4);
  const px = 2 / S;
  for (let j = 0; j < S; j++) {
    const sy = (((j + 0.5) * px - 1 - oy) / k + 1) / px - 0.5;
    const y0 = Math.floor(sy);
    if (y0 < -1 || y0 >= S) continue;
    const fy = sy - y0;
    for (let i = 0; i < S; i++) {
      const sx = (((i + 0.5) * px - 1 - ox) / k + 1) / px - 0.5;
      const x0 = Math.floor(sx);
      if (x0 < -1 || x0 >= S) continue;
      const fx = sx - x0;
      const o = (j * S + i) * 4;
      for (let dy = 0; dy < 2; dy++) {
        const yy = y0 + dy;
        if (yy < 0 || yy >= S) continue;
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx < 2; dx++) {
          const xx = x0 + dx;
          if (xx < 0 || xx >= S) continue;
          const w = wy * (dx ? fx : 1 - fx);
          const q = (yy * S + xx) * 4;
          out[o] += src[q] * w;
          out[o + 1] += src[q + 1] * w;
          out[o + 2] += src[q + 2] * w;
          out[o + 3] += src[q + 3] * w;
        }
      }
    }
  }
  return out;
}

/** Drops the memoised plain bodies (call once an atlas has finished baking). */
export function releasePbrMemo(): void {
  bodyMemo.clear();
  bodyMemoSize = 0;
}

function finish(S: number, col: Float32Array, sheen: Float32Array | null): PbrBakeResult {
  return { size: S, pixels: toBytes(col), sheen: sheen ? toBytes(sheen) : null };
}

/** Bakes one sprite at S×S device pixels. */
export function bakePbrSprite(spec: PbrSpriteSpec, S: number): PbrBakeResult {
  S = Math.max(8, Math.round(S));
  switch (spec.kind) {
    case 'candy': {
      const p = PAL[spec.color];
      if (spec.special === 'seeker') return bakeSeeker(spec.color, S);
      if (spec.special === 'wrapped') {
        // Reuse the plain candy's lit body, shrunk inside the cellophane.
        const body = plainBody(spec.color, S);
        const inner = resample(body.col, S, 0.66, 0, CY * 0.34);
        const innerCov = new Float32Array(S * S);
        for (let i = 0; i < innerCov.length; i++) innerCov[i] = inner[i * 4 + 3];
        const film = raster(S, wrapperFn(p));
        const filmMats = [
          mat({ op: 0.1, spec: 1.35, f0: 0.06, sss: 0, broad: 0.55, sharp: 2.2, rim: 0.55, rimC: p.light, deepen: 0, sheen: 1.2 }),
          mat({ op: 0.62, spec: 1.1, sss: 0.5, sssC: p.sss, broad: 0.5, sharp: 2, rim: 0.5, rimC: p.light, deepen: 0.3 }),
        ];
        const out = aura(S, 0, CY, 0.62, 0.5, p.glow);
        over(out, shadowFor(unionCov(innerCov, film.cov), S, p, 0.32));
        const cf = shade(film, filmMats, { sheen: true, ao: 1.2 });
        over(out, inner);
        over(out, cf.col);
        return finish(S, out, cf.sheen);
      }
      if (spec.special === 'none') {
        const body = plainBody(spec.color, S);
        const out = shadowFor(body.cov, S, p);
        over(out, body.col);
        return finish(S, out, body.sheen);
      }
      const fn = stripedFn(regularFn(spec.color, false), spec.special === 'striped-h' ? 'h' : 'v');
      const g = raster(S, fn);
      const out = shadowFor(g.cov, S, p);
      const c = shade(g, candyMats(spec.color), { sheen: true, ns: spec.color === 'orange' ? 1 : 1.05 });
      over(out, c.col);
      return finish(S, out, c.sheen);
    }
    case 'bomb': {
      const g = raster(S, bombFn());
      const mats = [
        mat({ spec: 1.5, f0: 0.06, broad: 0.55, sharp: 2.4, sss: 0.18, sssC: [0.85, 0.45, 0.25], rim: 0.5, rimC: [1, 0.75, 0.55], deepen: 0.3, amb: 0.3 }),
        mat({ spec: 1, broad: 0.6, sharp: 2, sharpSq: 7, sss: 0.35, deepen: 0.2, rim: 0.2 }),
      ];
      const out = aura(S, 0, CY, 0.8, 0.42, [1, 0.82, 0.45]);
      over(out, contactShadow(g.cov, S, { dx: 0.012, dy: 0.05, r: 0.032, a: 0.5, deep: [0.12, 0.04, 0.03], caustic: [0.9, 0.5, 0.75], ck: 0.35 }));
      const c = shade(g, mats, { sheen: true });
      over(out, c.col);
      return finish(S, out, c.sheen);
    }
    case 'cherry': {
      const g = raster(S, cherryFn());
      const mats = [
        mat({ spec: 1.3, sss: 0.7, sssC: [1, 0.3, 0.3], rim: 0.45, rimC: [1, 0.65, 0.6], deepen: 0.8 }),
        mat({ spec: 0.6, broad: 0.45, sharp: 0.7, sharpSq: 7, sss: 0.2, sssC: [0.8, 1, 0.5], rim: 0.25, deepen: 0.3 }),
        mat({ spec: 0.8, broad: 0.55, sharp: 1.1, sharpSq: 7, sss: 0.55, sssC: [0.7, 1, 0.45], rim: 0.3, deepen: 0.35 }),
        mat({ spec: 1.8, f0: 0.1, broad: 0.4, sharp: 3, sss: 0.4, sssC: [1, 0.7, 0.75], deepen: 0, rim: 0.6 }),
      ];
      const out = contactShadow(g.cov, S, { dx: 0.012, dy: 0.05, r: 0.03, a: 0.4, deep: [0.25, 0.02, 0.06], caustic: [1, 0.35, 0.4], ck: 0.55 });
      const c = shade(g, mats, { sheen: true });
      over(out, c.col);
      return finish(S, out, c.sheen);
    }
    case 'hazelnut': {
      const g = raster(S, hazelFn());
      const mats = [
        mat({ spec: 0.75, f0: 0.05, broad: 0.7, sharp: 0.7, sharpSq: 7, sss: 0.3, sssC: [1, 0.65, 0.35], rim: 0.3, rimC: [1, 0.85, 0.65], deepen: 0.5 }),
        mat({ spec: 0.4, f0: 0.04, broad: 0.35, sharp: 0.25, sharpSq: 6, sss: 0.15, sssC: [1, 0.85, 0.6], rim: 0.2, rimC: [1, 0.9, 0.75], deepen: 0.3 }),
        mat({ spec: 0.5, broad: 0.4, sharp: 0.4, sss: 0.1, deepen: 0.3 }),
      ];
      const out = contactShadow(g.cov, S, { dx: 0.012, dy: 0.05, r: 0.03, a: 0.42, deep: [0.2, 0.08, 0.03], caustic: [0.9, 0.55, 0.3], ck: 0.3 });
      const c = shade(g, mats, { sheen: true, ao: 2.6 });
      over(out, c.col);
      return finish(S, out, c.sheen);
    }
    case 'frosting': {
      const g = raster(S, frostingFn(spec.layers));
      const mats = [
        mat({ spec: 0.6, f0: 0.04, broad: 0.6, sharp: 0.9, sss: 0.5, sssC: [1, 0.9, 0.95], rim: 0.25, rimC: [1, 0.97, 1], deepen: 0.12, amb: 0.5, diff: 0.7 }),
        mat({ spec: 0.3, f0: 0.03, broad: 0.25, sharp: 0.2, sss: 0.3, sssC: [0.85, 0.8, 1], rim: 0.1, deepen: 0.1, amb: 0.45, diff: 0.7 }),
      ];
      const out = contactShadow(g.cov, S, { dx: 0, dy: 0.035, r: 0.03, a: 0.42, deep: [0.32, 0.22, 0.4], caustic: [0.9, 0.85, 1], ck: 0.2 });
      const c = shade(g, mats, { ao: 3.2, aoR: 0.05 });
      over(out, c.col);
      return finish(S, out, null);
    }
    case 'chocolate': {
      const g = raster(S, chocolateFn());
      const mats = [mat({ spec: 1.45, f0: 0.06, broad: 0.55, sharp: 2.2, sss: 0.15, sssC: [0.9, 0.5, 0.3], rim: 0.35, rimC: [1, 0.7, 0.5], deepen: 0.35, amb: 0.32 })];
      const out = contactShadow(g.cov, S, { dx: 0, dy: 0.035, r: 0.03, a: 0.5, deep: [0.12, 0.04, 0.02], caustic: [0.5, 0.25, 0.12], ck: 0.2 });
      const c = shade(g, mats, { ao: 2.5 });
      over(out, c.col);
      return finish(S, out, null);
    }
    case 'jelly': {
      const g = raster(S, jellyFn(spec.layers));
      const mats = [
        spec.layers === 1
          ? mat({ op: 0.5, spec: 1.2, f0: 0.06, broad: 0.4, sharp: 1.6, sss: 0.6, sssC: [1, 0.7, 0.85], rim: 0.5, rimC: [1, 0.85, 0.92], deepen: 0.2, amb: 0.5 })
          : mat({ op: 0.86, spec: 1.3, f0: 0.06, broad: 0.45, sharp: 1.8, sss: 0.75, sssC: [1, 0.35, 0.55], rim: 0.5, rimC: [1, 0.6, 0.75], deepen: 0.45, amb: 0.4 }),
      ];
      const c = shade(g, mats, { ao: 0 });
      return finish(S, c.col, null);
    }
    case 'locked': {
      const g = raster(S, lockedFn());
      const mats = [mat({ spec: 1.4, f0: 0.06, broad: 0.6, sharp: 2.2, sss: 0.12, sssC: [0.9, 0.4, 0.7], rim: 0.45, rimC: [1, 0.7, 0.9], deepen: 0.2, amb: 0.35 })];
      const out = contactShadow(g.cov, S, { dx: 0.02, dy: 0.04, r: 0.025, a: 0.5, deep: [0.05, 0.0, 0.03], caustic: [0.3, 0.1, 0.25], ck: 0 });
      const c = shade(g, mats, { ao: 1.5 });
      over(out, c.col);
      return finish(S, out, null);
    }
  }
}

/** Every sprite the atlas prewarms; used by the bake benchmark. */
export const PBR_PREWARM_SPECS: readonly PbrSpriteSpec[] = (() => {
  const out: PbrSpriteSpec[] = [];
  for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const) {
    for (const special of ['none', 'striped-h', 'striped-v', 'wrapped'] as const) out.push({ kind: 'candy', color, special });
  }
  out.push({ kind: 'bomb' }, { kind: 'cherry' }, { kind: 'hazelnut' });
  for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const) out.push({ kind: 'candy', color, special: 'seeker' });
  out.push({ kind: 'frosting', layers: 1 }, { kind: 'frosting', layers: 2 }, { kind: 'frosting', layers: 3 });
  out.push({ kind: 'chocolate' }, { kind: 'locked' }, { kind: 'jelly', layers: 1 }, { kind: 'jelly', layers: 2 });
  return out;
})();
