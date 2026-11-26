/**
 * Sugar Snap — layered Canvas 2D board renderer.
 *
 * Layers (back to front): baked tray + wells, exit chutes, jelly, halos and
 * hint glow, blockers, chocolate ooze, candies (spring transforms), licorice
 * locks, booster reticle, particles, flash.
 */
import type { BoosterType, Candy, Cell, ChapterDef, GridPos } from '../engine/types';
import { CandySpriteAtlas, GOLD, candyColorHex, makeCanvas, roundRectPath, withAlpha } from './candySprites';
import type { ParticleSystem } from './particles';

type Ctx = CanvasRenderingContext2D;

/** Per-candy animated state. Positions are in cell units (x = col, y = row). */
export interface CandyVisual {
  id: number;
  candy: Candy;
  x: number;
  y: number;
  /** Transient offsets in cell units (hint lean, nudges). */
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  velScaleX: number;
  velScaleY: number;
  rotation: number;
  velRotation: number;
  lift: number;
  liftTarget: number;
  pop: number;
  velPop: number;
  alpha: number;
  flash: number;
  /** Dying visuals are animated out by the controller and drawn on top. */
  dying: boolean;
}

export interface OozeFx {
  from: GridPos;
  to: GridPos;
  t: number;
}

export interface HintFx {
  a: GridPos;
  b: GridPos;
  strength: number;
}

export interface RenderFrame {
  time: number;
  grid: Cell[][];
  visuals: Iterable<CandyVisual>;
  dying: Iterable<CandyVisual>;
  selected: GridPos | null;
  hover: GridPos | null;
  activeBooster: BoosterType | null;
  hint: HintFx | null;
  oozes: OozeFx[];
  colorblindMode: boolean;
  reducedMotion: boolean;
  particles: ParticleSystem | null;
}

export interface BoardLayout {
  viewW: number;
  viewH: number;
  dpr: number;
  rows: number;
  cols: number;
  cellSize: number;
  originX: number;
  originY: number;
  boardW: number;
  boardH: number;
}

const DEFAULT_TRAY = '#c98a4b';
/** Extra cells of space around the grid (both sides together) for frame + shadow. */
const TRAY_MARGIN = 1.36;
/** How far the outer frame extends past the playable cells, in cells. */
const FRAME_EXPAND = 0.33;
/** Seconds between diagonal glass-glint sweeps. */
const GLINT_PERIOD = 5.5;
/** Per-frame budget for streaming queued sprite bakes, in ms. */
const IDLE_BAKE_MS = 3;
const BOMB_CAUSTICS = ['#ff6fa8', '#ffd45c', '#6fe3ff', '#b98cff', '#7dffb0'];
/** Warm glazed caramel-cocoa every chapter tray tint is pulled toward. */
const TRAY_COCOA: readonly [number, number, number] = [0x6e, 0x3c, 0x24];

/**
 * Clamps a chapter's tray tint into the warm caramel-cocoa family so the gold
 * frame and glazed body never turn muddy olive or teal: cool and green hues are
 * blended hard toward cocoa, warm plums keep a little of their character.
 */
export function warmTrayTint(hex: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgb(${TRAY_COCOA.join(',')})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  // Warm reds/oranges/plums (≥ 290° or ≤ 40°) keep 45%; anything cooler keeps at most 12%.
  const warm = hue >= 290 || hue <= 40;
  const keep = max === min ? 0.3 : warm ? 0.45 : 0.12;
  const mix = (c: number, k: number) => Math.round(c * keep + TRAY_COCOA[k] * (1 - keep));
  // Never let green dominate red in the result.
  const R = mix(r, 0);
  const G = Math.min(mix(g, 1), Math.round(R * 0.62));
  const B = Math.min(mix(b, 2), Math.round(R * 0.7));
  return `rgb(${R},${G},${B})`;
}

export class BoardRenderer {
  readonly atlas: CandySpriteAtlas;
  private canvas: HTMLCanvasElement;
  private ctx: Ctx;
  private layout: BoardLayout = {
    viewW: 1,
    viewH: 1,
    dpr: 1,
    rows: 9,
    cols: 9,
    cellSize: 40,
    originX: 0,
    originY: 0,
    boardW: 360,
    boardH: 360,
  };
  private chapter: ChapterDef | null = null;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  private visBuf: CandyVisual[] = [];

  constructor(canvas: HTMLCanvasElement, atlas?: CandySpriteAtlas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.atlas = atlas ?? new CandySpriteAtlas();
  }

  setChapter(chapter: ChapterDef | null): void {
    this.chapter = chapter;
    this.staticKey = '';
  }

  /** Sizes the backing store and fits the board into the view (CSS pixels). */
  setLayout(viewW: number, viewH: number, dpr: number, rows: number, cols: number): BoardLayout {
    const w = Math.max(1, viewW);
    const h = Math.max(1, viewH);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    // Leave room for the tray frame (~0.33 cell) plus a feathered shadow that
    // fades out well before the canvas edge (~0.68 cell on each side in total).
    const cs = Math.max(8, Math.floor(Math.min(w / (cols + TRAY_MARGIN), h / (rows + TRAY_MARGIN)) * dpr) / dpr);
    const boardW = cs * cols;
    const boardH = cs * rows;
    this.layout = {
      viewW: w,
      viewH: h,
      dpr,
      rows,
      cols,
      cellSize: cs,
      originX: Math.round(((w - boardW) / 2) * dpr) / dpr,
      originY: Math.round(((h - boardH) / 2) * dpr) / dpr,
      boardW,
      boardH,
    };
    this.atlas.ensure(cs, dpr);
    this.staticKey = '';
    return this.layout;
  }

  getLayout(): BoardLayout {
    return this.layout;
  }

  get cellSize(): number {
    return this.layout.cellSize;
  }

  /** Center of a (possibly fractional) cell, in CSS pixels. */
  cellCenter(row: number, col: number): { x: number; y: number } {
    const { originX, originY, cellSize } = this.layout;
    return { x: originX + (col + 0.5) * cellSize, y: originY + (row + 0.5) * cellSize };
  }

  /** Maps a CSS-pixel point to a grid cell, or null if outside the grid. */
  pointToCell(x: number, y: number): GridPos | null {
    const { originX, originY, cellSize, rows, cols } = this.layout;
    const col = Math.floor((x - originX) / cellSize);
    const row = Math.floor((y - originY) / cellSize);
    if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
    return { row, col };
  }

  /* --------------------------------------------------------------------- */
  /* Static tray layer                                                      */
  /* --------------------------------------------------------------------- */

  private ensureStatic(grid: Cell[][]): HTMLCanvasElement {
    const L = this.layout;
    let mask = '';
    for (const row of grid) for (const c of row) mask += c.playable ? '1' : '0';
    const key = `${L.viewW}x${L.viewH}@${L.dpr}|${L.cellSize}|${L.rows}x${L.cols}|${mask}|${this.chapter?.id ?? 0}|${this.chapter?.trayTint ?? ''}`;
    if (this.staticLayer && key === this.staticKey) return this.staticLayer;
    this.staticLayer = this.buildStatic(grid);
    this.staticKey = key;
    return this.staticLayer;
  }

  private buildStatic(grid: Cell[][]): HTMLCanvasElement {
    const L = this.layout;
    const { dpr, cellSize: cs, originX: ox, originY: oy } = L;
    const W = Math.max(1, Math.round(L.viewW * dpr));
    const H = Math.max(1, Math.round(L.viewH * dpr));
    const [out, octx] = makeCanvas(W, H);
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const playable = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols && grid[r][c].playable;

    /** Union of rounded, expanded playable cells, with filleted concave corners. */
    const unionMask = (expand: number, radius: number): HTMLCanvasElement => {
      const [m, mctx] = makeCanvas(W, H);
      mctx.scale(dpr, dpr);
      mctx.fillStyle = '#000';
      mctx.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!playable(r, c)) continue;
          roundRectPath(mctx, ox + c * cs - expand, oy + r * cs - expand, cs + expand * 2, cs + expand * 2, radius);
        }
      }
      mctx.fill();
      // Bridge horizontal & vertical neighbors so rounded corners don't notch seams.
      mctx.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!playable(r, c)) continue;
          if (playable(r, c + 1)) mctx.rect(ox + c * cs + cs / 2, oy + r * cs - expand, cs, cs + expand * 2);
          if (playable(r + 1, c)) mctx.rect(ox + c * cs - expand, oy + r * cs + cs / 2, cs + expand * 2, cs);
          if (playable(r, c + 1) && playable(r + 1, c) && playable(r + 1, c + 1)) mctx.rect(ox + c * cs + cs / 2, oy + r * cs + cs / 2, cs, cs);
        }
      }
      mctx.fill();
      // Organic fillets on hole corners (concave corners of the tray).
      const gap = cs - expand * 2;
      if (gap > 2) {
        const f = Math.min(radius, gap / 2);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (playable(r, c)) continue;
            const corners: Array<[number, number, number, number]> = [
              [-1, -1, 0, 0],
              [1, -1, 1, 0],
              [-1, 1, 0, 1],
              [1, 1, 1, 1],
            ];
            for (const [dx, dy, kx, ky] of corners) {
              if (!playable(r, c + dx) || !playable(r + dy, c)) continue;
              const px = ox + (c + kx) * cs - dx * expand;
              const py = oy + (r + ky) * cs - dy * expand;
              const sx = -dx; // direction into the hole
              const sy = -dy;
              mctx.fillStyle = '#000';
              mctx.fillRect(Math.min(px, px + sx * f), Math.min(py, py + sy * f), f, f);
              mctx.globalCompositeOperation = 'destination-out';
              mctx.beginPath();
              mctx.arc(px + sx * f, py + sy * f, f, 0, Math.PI * 2);
              mctx.fill();
              mctx.globalCompositeOperation = 'source-over';
            }
          }
        }
      }
      return m;
    };

    const tinted = (mask: HTMLCanvasElement, paint: (ctx: Ctx) => void): HTMLCanvasElement => {
      // Paint freely, then keep only what falls inside the mask.
      const [t, tctx] = makeCanvas(W, H);
      tctx.save();
      tctx.scale(dpr, dpr);
      paint(tctx);
      tctx.restore();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(mask, 0, 0);
      tctx.globalCompositeOperation = 'source-over';
      return t;
    };

    /** Inner shadow / inner glow clipped to the layer's own alpha. */
    const innerShade = (layer: HTMLCanvasElement, mask: HTMLCanvasElement, color: string, blur: number, offY: number) => {
      const [inv, ictx] = makeCanvas(W, H);
      ictx.fillStyle = '#000';
      ictx.fillRect(0, 0, W, H);
      ictx.globalCompositeOperation = 'destination-out';
      ictx.drawImage(mask, 0, 0);
      const lctx = layer.getContext('2d')!;
      lctx.save();
      lctx.globalCompositeOperation = 'source-atop';
      lctx.shadowColor = color;
      lctx.shadowBlur = blur * dpr;
      lctx.shadowOffsetY = offY * dpr;
      lctx.drawImage(inv, 0, 0);
      lctx.restore();
    };

    const trayTint = warmTrayTint(this.chapter?.trayTint || DEFAULT_TRAY);
    const top = oy - cs * 0.5;
    const bottom = oy + L.boardH + cs * 0.5;
    const left = ox - cs * 0.5;
    const right = ox + L.boardW + cs * 0.5;

    // 1. Feathered ambient shadow that melts into the stage. It is sized to the
    //    free space around the frame and edge-faded, so the canvas rectangle
    //    never shows as a square cut-off.
    const frameMask = unionMask(cs * FRAME_EXPAND, cs * 0.5);
    const free = Math.max(2, Math.min(ox, oy, L.viewW - ox - L.boardW, L.viewH - oy - L.boardH) - cs * FRAME_EXPAND);
    const [shadow, sctx] = makeCanvas(W, H);
    const castShadow = (color: string, blur: number, offY: number) => {
      // Shadow only: draw the mask off-canvas and offset its shadow back into view.
      sctx.save();
      sctx.shadowColor = color;
      sctx.shadowBlur = blur * dpr;
      sctx.shadowOffsetX = W + 64;
      sctx.shadowOffsetY = offY * dpr;
      sctx.drawImage(frameMask, -W - 64, 0);
      sctx.restore();
    };
    castShadow('rgba(64, 18, 52, 0.30)', Math.min(cs * 0.5, free * 0.8), Math.min(cs * 0.14, free * 0.25));
    castShadow('rgba(80, 24, 40, 0.30)', cs * 0.09, cs * 0.045);
    const feather = Math.max(3, free * 0.45) * dpr;
    const [fade, fctx] = makeCanvas(W, H);
    fctx.shadowColor = '#000';
    fctx.shadowBlur = feather;
    fctx.shadowOffsetX = W + 64;
    fctx.fillStyle = '#000';
    fctx.fillRect(-W - 64 + feather, feather, W - feather * 2, H - feather * 2);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(fade, 0, 0);
    octx.drawImage(shadow, 0, 0);

    // 2. Caramel-gold bead rim: polished metal bands catching the studio light.
    const rim = tinted(frameMask, (c) => {
      // Polished caramel-gold, warmed only lightly by the chapter tint.
      const g = c.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, '#fff3c4');
      g.addColorStop(0.06, '#ffd36e');
      g.addColorStop(0.2, '#c2852a');
      g.addColorStop(0.48, '#ffe09a');
      g.addColorStop(0.76, '#c98d33');
      g.addColorStop(1, '#7a4710');
      c.fillStyle = g;
      c.fillRect(0, 0, L.viewW, L.viewH);
      c.globalCompositeOperation = 'multiply';
      c.globalAlpha = 0.14;
      c.fillStyle = trayTint;
      c.fillRect(0, 0, L.viewW, L.viewH);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      const sw = c.createLinearGradient(left, top, right, bottom);
      sw.addColorStop(0, 'rgba(255,255,255,0.45)');
      sw.addColorStop(0.18, 'rgba(255,255,255,0)');
      sw.addColorStop(0.62, 'rgba(255,255,255,0)');
      sw.addColorStop(0.7, 'rgba(255,250,230,0.22)');
      sw.addColorStop(0.78, 'rgba(255,255,255,0)');
      c.fillStyle = sw;
      c.fillRect(0, 0, L.viewW, L.viewH);
    });
    innerShade(rim, frameMask, 'rgba(255,250,228,0.95)', cs * 0.035, cs * 0.03);
    innerShade(rim, frameMask, 'rgba(70,30,0,0.55)', cs * 0.06, -cs * 0.04);
    octx.drawImage(rim, 0, 0);

    // 3. Glazed caramel porcelain body inside the gold bead.
    const bodyMask = unionMask(cs * (FRAME_EXPAND - 0.055), cs * 0.44);
    const body = tinted(bodyMask, (c) => {
      c.fillStyle = trayTint;
      c.fillRect(0, 0, L.viewW, L.viewH);
      const glaze = c.createLinearGradient(0, top, 0, bottom);
      glaze.addColorStop(0, 'rgba(255,244,222,0.62)');
      glaze.addColorStop(0.12, 'rgba(255,226,180,0.18)');
      glaze.addColorStop(0.6, 'rgba(120,55,15,0.06)');
      glaze.addColorStop(1, 'rgba(70,25,5,0.4)');
      c.fillStyle = glaze;
      c.fillRect(0, 0, L.viewW, L.viewH);
      // Softbox reflections gliding across the glaze.
      c.globalCompositeOperation = 'screen';
      const win = c.createLinearGradient(left, top, left + (right - left) * 0.55, top + (bottom - top) * 0.55);
      win.addColorStop(0, 'rgba(255,255,255,0.5)');
      win.addColorStop(0.28, 'rgba(255,255,255,0.08)');
      win.addColorStop(0.36, 'rgba(255,255,255,0.3)');
      win.addColorStop(0.44, 'rgba(255,255,255,0)');
      c.fillStyle = win;
      c.fillRect(0, 0, L.viewW, L.viewH);
      c.globalCompositeOperation = 'source-over';
    });
    innerShade(body, bodyMask, 'rgba(255,240,215,0.9)', cs * 0.05, cs * 0.045);
    innerShade(body, bodyMask, 'rgba(70,25,5,0.5)', cs * 0.1, -cs * 0.06);
    octx.save();
    octx.shadowColor = 'rgba(80,35,0,0.45)';
    octx.shadowBlur = cs * 0.035 * dpr;
    octx.shadowOffsetY = cs * 0.012 * dpr;
    octx.drawImage(body, 0, 0);
    octx.restore();

    // 4. Frosted porcelain lip.
    const lipMask = unionMask(cs * 0.17, cs * 0.34);
    const lip = tinted(lipMask, (c) => {
      const g = c.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, '#fffaf4');
      g.addColorStop(0.5, '#fbeee6');
      g.addColorStop(1, '#ecd8d2');
      c.fillStyle = g;
      c.fillRect(0, 0, L.viewW, L.viewH);
      const gl = c.createLinearGradient(0, top, 0, top + cs * 0.6);
      gl.addColorStop(0, 'rgba(255,255,255,0.9)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gl;
      c.fillRect(0, 0, L.viewW, L.viewH);
    });
    innerShade(lip, lipMask, 'rgba(160,110,110,0.45)', cs * 0.06, cs * 0.04);
    octx.save();
    octx.shadowColor = 'rgba(90,30,10,0.35)';
    octx.shadowBlur = cs * 0.08 * dpr;
    octx.shadowOffsetY = cs * 0.03 * dpr;
    octx.drawImage(lip, 0, 0);
    octx.restore();

    // 5. Recessed frosted-glass wells with checkerboard.
    const wellMask = unionMask(cs * 0.035, cs * 0.2);
    const wells = tinted(wellMask, (c) => {
      const g = c.createLinearGradient(0, oy, 0, oy + L.boardH);
      // Warm, rich plum-berry wells: candy colours pop without going muddy.
      g.addColorStop(0, 'rgba(92,42,96,0.8)');
      g.addColorStop(1, 'rgba(64,24,66,0.86)');
      c.fillStyle = g;
      c.fillRect(0, 0, L.viewW, L.viewH);
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          if (!playable(r, col)) continue;
          const light = (r + col) % 2 === 0;
          c.beginPath();
          roundRectPath(c, ox + col * cs + cs * 0.045, oy + r * cs + cs * 0.045, cs * 0.91, cs * 0.91, cs * 0.18);
          c.fillStyle = light ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
          c.fill();
          const fg = c.createLinearGradient(0, oy + r * cs, 0, oy + (r + 1) * cs);
          fg.addColorStop(0, 'rgba(255,255,255,0.07)');
          fg.addColorStop(0.45, 'rgba(255,255,255,0)');
          fg.addColorStop(1, 'rgba(255,214,200,0.07)');
          c.fillStyle = fg;
          c.fill();
        }
      }
    });
    innerShade(wells, wellMask, 'rgba(15,0,25,0.75)', cs * 0.16, cs * 0.07);
    innerShade(wells, wellMask, 'rgba(255,220,255,0.3)', cs * 0.04, -cs * 0.03);
    octx.drawImage(wells, 0, 0);

    return out;
  }

  /* --------------------------------------------------------------------- */
  /* Per-frame rendering                                                    */
  /* --------------------------------------------------------------------- */

  render(frame: RenderFrame): void {
    const ctx = this.ctx;
    const L = this.layout;
    const { dpr, cellSize: cs, originX: ox, originY: oy } = L;
    const grid = frame.grid;
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;
    const t = frame.time;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const shake = frame.particles?.getShakeOffset() ?? { x: 0, y: 0 };
    ctx.save();
    ctx.translate(shake.x, shake.y);

    if (rows > 0) ctx.drawImage(this.ensureStatic(grid), 0, 0, L.viewW, L.viewH);

    // Exit chutes.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (cell.playable && cell.isExit) this.drawExit(ctx, r, c, t, frame.reducedMotion);
      }
    }

    // Jelly beneath candies.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!cell.playable || cell.jelly === 0) continue;
        ctx.drawImage(this.atlas.getJelly(cell.jelly), ox + c * cs, oy + r * cs, cs, cs);
      }
    }

    // Hint glow & selection halo.
    if (frame.hint && frame.hint.strength > 0.01) {
      const s = frame.hint.strength;
      const glow = this.atlas.getGlow(GOLD);
      for (const p of [frame.hint.a, frame.hint.b]) {
        const pulse = 0.55 + 0.45 * Math.sin(t * 4.2);
        ctx.globalAlpha = s * 0.55 * pulse;
        ctx.drawImage(glow, ox + (p.col - 0.25) * cs, oy + (p.row - 0.25) * cs, cs * 1.5, cs * 1.5);
      }
      ctx.globalAlpha = 1;
    }
    if (frame.selected) this.drawHalo(ctx, frame.selected, t);

    // Blockers that occupy a cell (frosting, chocolate).
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!cell.playable) continue;
        if (cell.frosting > 0) {
          ctx.drawImage(this.atlas.getFrosting(cell.frosting as 1 | 2 | 3), ox + c * cs, oy + r * cs, cs, cs);
        } else if (cell.chocolate) {
          ctx.drawImage(this.atlas.getBlocker('chocolate'), ox + c * cs, oy + r * cs, cs, cs);
        }
      }
    }

    // Chocolate ooze spreading into a neighbor.
    for (const o of frame.oozes) {
      const e = 1 - Math.pow(1 - Math.min(1, o.t), 3);
      const x = o.from.col + (o.to.col - o.from.col) * e;
      const y = o.from.row + (o.to.row - o.from.row) * e;
      const s = 0.35 + 0.65 * e;
      const wob = 1 + Math.sin(o.t * 18) * 0.06 * (1 - e);
      const cx = ox + (x + 0.5) * cs;
      const cy = oy + (y + 0.5) * cs;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s * wob, (s / wob) * 1);
      ctx.drawImage(this.atlas.getBlocker('chocolate'), -cs / 2, -cs / 2, cs, cs);
      ctx.restore();
    }

    // Collect visuals once (frame.visuals may be a one-shot iterator).
    const vis = this.visBuf;
    vis.length = 0;
    for (const v of frame.visuals) vis.push(v);

    // Candies, clipped to the board so refills slide in from the top edge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox - cs * 0.3, oy - cs * 0.14, L.boardW + cs * 0.6, L.boardH + cs * 0.44);
    ctx.clip();
    this.drawCaustics(ctx, vis, frame);
    const lifted: CandyVisual[] = [];
    for (const v of vis) {
      if (v.lift > 0.05) lifted.push(v);
      else this.drawCandy(ctx, v, frame, false);
    }
    lifted.sort((a, b) => a.lift - b.lift);
    for (const v of lifted) this.drawCandy(ctx, v, frame, false);
    for (const v of frame.dying) this.drawCandy(ctx, v, frame, true);
    ctx.restore();

    // Licorice locks over candies.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (cell.playable && cell.locked) ctx.drawImage(this.atlas.getBlocker('locked'), ox + c * cs, oy + r * cs, cs, cs);
      }
    }

    // Hint sparkle trail between the pair.
    if (frame.hint && frame.hint.strength > 0.01) this.drawHintSpark(ctx, frame.hint, t);

    // Booster reticle.
    if (frame.activeBooster === 'hammer' || frame.activeBooster === 'free-switch') {
      this.drawBoosterMode(ctx, frame.activeBooster, frame.hover ?? frame.selected, t, frame.reducedMotion);
    }

    frame.particles?.draw(ctx, L.viewW, L.viewH);
    ctx.restore();

    // Stream the remaining PBR sprites a few milliseconds per frame.
    if (this.atlas.pendingBakes > 0) this.atlas.bakeIdle(IDLE_BAKE_MS);
  }

  private isAt(p: GridPos | null, v: CandyVisual): boolean {
    return !!p && Math.round(v.x) === p.col && Math.round(v.y) === p.row && Math.abs(v.x - p.col) < 0.2 && Math.abs(v.y - p.row) < 0.2;
  }

  /** Coloured caustic light pooling in the frosted well beneath specials and the selected candy. */
  private drawCaustics(ctx: Ctx, vis: readonly CandyVisual[], frame: RenderFrame): void {
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const t = frame.time;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const v of vis) {
      if (v.dying || v.alpha <= 0.05 || v.pop <= 0.05) continue;
      const special = v.candy.special !== 'none' && !v.candy.ingredient;
      const selected = this.isAt(frame.selected, v);
      if (!special && !selected) continue;
      let color: string;
      if (v.candy.special === 'color-bomb') {
        color = BOMB_CAUSTICS[Math.floor((frame.reducedMotion ? 0 : t * 1.4) + v.id) % BOMB_CAUSTICS.length];
      } else color = candyColorHex(v.candy.color);
      const pulse = frame.reducedMotion ? 1 : 0.82 + 0.18 * Math.sin(t * 3.1 + v.id * 1.7);
      const a = (selected ? 0.55 : 0.36) * pulse * Math.min(1, v.alpha);
      const cx = ox + (v.x + v.offsetX + 0.5) * cs;
      const cy = oy + (v.y + v.offsetY + 0.5) * cs + cs * 0.14;
      const w = cs * (selected ? 1.25 : 1.1) * v.pop;
      ctx.globalAlpha = a;
      ctx.drawImage(this.atlas.getGlow(color), cx - w / 2, cy - w * 0.32, w, w * 0.64);
    }
    ctx.restore();
  }

  /** Strength of the moving glass glint for a candy (0..1). */
  private glintFor(v: CandyVisual, frame: RenderFrame): number {
    const L = this.layout;
    const t = frame.time;
    const reduced = frame.reducedMotion;
    let g = 0;
    if (!reduced) {
      // A soft diagonal sweep rippling across the board every few seconds.
      const phase = (t % GLINT_PERIOD) / GLINT_PERIOD;
      const band = phase * 1.7 - 0.35;
      const pos = (v.x + v.y) / Math.max(1, L.rows + L.cols - 2);
      const d = (pos - band) / 0.09;
      if (d > -3 && d < 3) g = Math.exp(-d * d) * 0.7;
    }
    if (this.isAt(frame.selected, v) || this.isAt(frame.hover, v)) {
      g = Math.max(g, reduced ? 0.6 : 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 7)));
    } else if (v.candy.special !== 'none' && !v.candy.ingredient) {
      const s = reduced ? 0.3 : 0.2 + 0.5 * Math.pow(Math.max(0, Math.sin(t * 2.3 + v.id * 0.9)), 6);
      g = Math.max(g, s);
    }
    return g;
  }

  private drawCandy(ctx: Ctx, v: CandyVisual, frame: RenderFrame, dying: boolean): void {
    if (v.alpha <= 0.01 || v.pop <= 0.01) return;
    const colorblind = frame.colorblindMode;
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const sprite = this.atlas.getCandy(v.candy);
    const cx = ox + (v.x + v.offsetX + 0.5) * cs;
    // Sugar Bees hover: a soft bob and a little bank, as if their wings are buzzing.
    const bee = v.candy.special === 'seeker' && !dying && !frame.reducedMotion;
    const beePhase = frame.time * 4.2 + v.id * 1.3;
    const bob = bee ? Math.sin(beePhase) * cs * 0.028 : 0;
    const bank = bee ? Math.sin(beePhase * 0.5 + 0.8) * 0.05 : 0;
    const cy = oy + (v.y + v.offsetY + 0.5) * cs - v.lift * cs * 0.07 + bob;
    const s = v.pop * (1 + 0.07 * v.lift);
    const anchor = cs * 0.36; // squash pivots near the candy's base
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha));
    ctx.translate(cx, cy + anchor);
    if (v.rotation || bank) ctx.rotate(v.rotation + bank);
    ctx.scale(v.scaleX * s, v.scaleY * s);
    ctx.translate(0, -anchor);
    if (v.lift > 0.05) {
      // Floating contact shadow when lifted.
      ctx.save();
      ctx.globalAlpha *= 0.35 * Math.min(1, v.lift);
      ctx.fillStyle = 'rgba(30,5,30,1)';
      ctx.beginPath();
      ctx.ellipse(0, cs * 0.36 + v.lift * cs * 0.06, cs * 0.3, cs * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.drawImage(sprite, -cs / 2, -cs / 2, cs, cs);
    const glint = dying ? 0 : this.glintFor(v, frame);
    if (glint > 0.02) {
      const sheen = this.atlas.getCandySheen(v.candy);
      if (sheen) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha)) * Math.min(1, glint);
        ctx.drawImage(sheen, -cs / 2, -cs / 2, cs, cs);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha));
      }
    }
    if (v.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha)) * Math.min(1, v.flash) * 0.85;
      ctx.drawImage(sprite, -cs / 2, -cs / 2, cs, cs);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha));
    }
    if (colorblind && !v.candy.ingredient && v.candy.special !== 'color-bomb' && v.candy.color !== 'none') {
      ctx.drawImage(this.atlas.getColorblindBadge(v.candy.color), -cs / 2, -cs / 2, cs, cs);
    }
    ctx.restore();
  }

  private drawHalo(ctx: Ctx, p: GridPos, t: number): void {
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    const glow = this.atlas.getGlow('#fff1b8');
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.25 * pulse;
    ctx.drawImage(glow, ox + (p.col - 0.3) * cs, oy + (p.row - 0.3) * cs, cs * 1.6, cs * 1.6);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    roundRectPath(ctx, ox + p.col * cs + cs * 0.04, oy + p.row * cs + cs * 0.04, cs * 0.92, cs * 0.92, cs * 0.22);
    ctx.lineWidth = cs * 0.05;
    ctx.strokeStyle = `rgba(255,255,255,${0.65 + 0.3 * pulse})`;
    ctx.shadowColor = 'rgba(255,215,120,0.9)';
    ctx.shadowBlur = cs * 0.25 * this.layout.dpr;
    ctx.stroke();
    ctx.restore();
  }

  private drawHintSpark(ctx: Ctx, hint: HintFx, t: number): void {
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const mx = ox + ((hint.a.col + hint.b.col) / 2 + 0.5) * cs;
    const my = oy + ((hint.a.row + hint.b.row) / 2 + 0.5) * cs;
    const tw = 0.5 + 0.5 * Math.sin(t * 7);
    const r = cs * (0.12 + 0.08 * tw) * hint.strength;
    ctx.save();
    ctx.globalAlpha = hint.strength;
    ctx.translate(mx, my);
    ctx.rotate(t * 1.5);
    ctx.globalCompositeOperation = 'lighter';
    const glow = this.atlas.getGlow(GOLD);
    ctx.drawImage(glow, -r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
    ctx.fillStyle = '#fffbe6';
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.4);
    ctx.quadraticCurveTo(0, 0, r * 1.4, 0);
    ctx.quadraticCurveTo(0, 0, 0, r * 1.4);
    ctx.quadraticCurveTo(0, 0, -r * 1.4, 0);
    ctx.quadraticCurveTo(0, 0, 0, -r * 1.4);
    ctx.fill();
    ctx.restore();
  }

  private drawExit(ctx: Ctx, r: number, c: number, t: number, reduced: boolean): void {
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const cx = ox + (c + 0.5) * cs;
    const base = oy + (r + 1) * cs;
    // Warm glow pooling at the bottom of the exit cell.
    const g = ctx.createLinearGradient(0, base - cs * 0.6, 0, base);
    g.addColorStop(0, 'rgba(255,214,110,0)');
    g.addColorStop(1, 'rgba(255,214,110,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(ox + c * cs + cs * 0.08, base - cs * 0.6, cs * 0.84, cs * 0.6);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      const phase = reduced ? 0.5 : (t * 1.6 - i * 0.35) % 1;
      const a = reduced ? 0.85 : 0.35 + 0.65 * Math.sin(Math.max(0, Math.min(1, phase)) * Math.PI);
      const y = base + cs * (0.06 + i * 0.13);
      ctx.beginPath();
      ctx.moveTo(cx - cs * 0.16, y);
      ctx.lineTo(cx, y + cs * 0.1);
      ctx.lineTo(cx + cs * 0.16, y);
      ctx.lineWidth = cs * 0.075;
      ctx.strokeStyle = `rgba(122,58,0,${0.55 * a})`;
      ctx.stroke();
      ctx.lineWidth = cs * 0.045;
      ctx.strokeStyle = `rgba(255,226,120,${a})`;
      ctx.shadowColor = 'rgba(255,200,80,0.9)';
      ctx.shadowBlur = cs * 0.15 * this.layout.dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  private drawBoosterMode(ctx: Ctx, booster: 'hammer' | 'free-switch', target: GridPos | null, t: number, reduced: boolean): void {
    const L = this.layout;
    const { cellSize: cs, originX: ox, originY: oy } = L;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    const color = booster === 'hammer' ? '#ff7a59' : '#7ee0ff';
    // Board outline glow announces the active mode.
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, ox - cs * 0.1, oy - cs * 0.1, L.boardW + cs * 0.2, L.boardH + cs * 0.2, cs * 0.3);
    ctx.setLineDash([cs * 0.22, cs * 0.16]);
    ctx.lineDashOffset = reduced ? 0 : -t * cs * 0.8;
    ctx.lineWidth = cs * 0.05;
    ctx.strokeStyle = withAlpha(color, 0.55 + 0.35 * pulse);
    ctx.shadowColor = color;
    ctx.shadowBlur = cs * 0.3 * L.dpr;
    ctx.stroke();
    ctx.restore();
    if (!target) return;
    const cx = ox + (target.col + 0.5) * cs;
    const cy = oy + (target.row + 0.5) * cs;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = cs * 0.2 * L.dpr;
    if (booster === 'hammer') {
      const r = cs * (0.46 + 0.04 * pulse);
      ctx.rotate(reduced ? 0 : t * 0.8);
      ctx.lineWidth = cs * 0.05;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = cs * 0.06;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62);
        ctx.lineTo(Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12);
        ctx.stroke();
      }
    } else {
      const r = cs * 0.48;
      ctx.rotate(reduced ? 0 : t * 1.2);
      ctx.lineWidth = cs * 0.055;
      ctx.strokeStyle = color;
      for (let i = 0; i < 2; i++) {
        ctx.save();
        ctx.rotate(i * Math.PI);
        ctx.beginPath();
        ctx.arc(0, 0, r, -Math.PI * 0.15, Math.PI * 0.6);
        ctx.stroke();
        const ax = Math.cos(Math.PI * 0.6) * r;
        const ay = Math.sin(Math.PI * 0.6) * r;
        ctx.beginPath();
        ctx.moveTo(ax + cs * 0.1, ay - cs * 0.02);
        ctx.lineTo(ax, ay);
        ctx.lineTo(ax + cs * 0.04, ay - cs * 0.11);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
}
