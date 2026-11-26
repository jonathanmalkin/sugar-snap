/**
 * Sugar Snap — layered Canvas 2D board renderer.
 *
 * Layers (back to front): baked tray + wells, exit chutes, jelly, halos and
 * hint glow, blockers, chocolate ooze, candies (spring transforms), licorice
 * locks, booster reticle, particles, flash.
 */
import type { BoosterType, Candy, Cell, ChapterDef, GridPos } from '../engine/types';
import { CandySpriteAtlas, GOLD, makeCanvas, roundRectPath, withAlpha } from './candySprites';
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
    // Leave room for the tray frame (~0.45 cell on each side).
    const cs = Math.max(8, Math.floor(Math.min(w / (cols + 0.95), h / (rows + 0.95)) * dpr) / dpr);
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

    const trayTint = this.chapter?.trayTint || DEFAULT_TRAY;
    const top = oy - cs * 0.5;
    const bottom = oy + L.boardH + cs * 0.5;

    // 1. Soft ambient drop shadow under the whole tray.
    const frameMask = unionMask(cs * 0.36, cs * 0.5);
    // Shadow only: draw the mask off-canvas and offset its shadow back into view.
    octx.save();
    octx.shadowColor = 'rgba(55, 15, 40, 0.45)';
    octx.shadowBlur = cs * 0.55 * dpr;
    octx.shadowOffsetX = W + 64;
    octx.shadowOffsetY = cs * 0.2 * dpr;
    octx.drawImage(frameMask, -W - 64, 0);
    octx.restore();

    // 2. Caramel-wood frame tinted by chapter.
    const frame = tinted(frameMask, (c) => {
      c.fillStyle = trayTint;
      c.fillRect(0, 0, L.viewW, L.viewH);
      const sheen = c.createLinearGradient(0, top, 0, bottom);
      sheen.addColorStop(0, 'rgba(255,240,215,0.5)');
      sheen.addColorStop(0.18, 'rgba(255,220,170,0.12)');
      sheen.addColorStop(0.7, 'rgba(90,40,10,0.08)');
      sheen.addColorStop(1, 'rgba(60,20,5,0.35)');
      c.fillStyle = sheen;
      c.fillRect(0, 0, L.viewW, L.viewH);
      // Wood grain.
      c.lineWidth = Math.max(1, cs * 0.025);
      for (let i = 0; i < 44; i++) {
        const y0 = top + (i / 44) * (bottom - top);
        c.strokeStyle = i % 3 === 0 ? 'rgba(110,50,15,0.12)' : 'rgba(255,230,190,0.07)';
        c.beginPath();
        for (let x = ox - cs; x <= ox + L.boardW + cs; x += cs * 0.25) {
          const y = y0 + Math.sin(x / (cs * 1.3) + i * 1.7) * cs * 0.06 + Math.sin(x / (cs * 0.37) + i) * cs * 0.015;
          if (x === ox - cs) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      }
    });
    innerShade(frame, frameMask, 'rgba(255,245,225,0.85)', cs * 0.06, cs * 0.05);
    innerShade(frame, frameMask, 'rgba(70,25,5,0.45)', cs * 0.12, -cs * 0.07);
    octx.drawImage(frame, 0, 0);

    // 3. Frosted porcelain lip.
    const lipMask = unionMask(cs * 0.17, cs * 0.34);
    const lip = tinted(lipMask, (c) => {
      const g = c.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, '#fffaf4');
      g.addColorStop(0.5, '#fbeee6');
      g.addColorStop(1, '#ecd8d2');
      c.fillStyle = g;
      c.fillRect(0, 0, L.viewW, L.viewH);
    });
    innerShade(lip, lipMask, 'rgba(160,110,110,0.45)', cs * 0.06, cs * 0.04);
    octx.save();
    octx.shadowColor = 'rgba(90,30,10,0.35)';
    octx.shadowBlur = cs * 0.08 * dpr;
    octx.shadowOffsetY = cs * 0.03 * dpr;
    octx.drawImage(lip, 0, 0);
    octx.restore();

    // 4. Recessed frosted-glass wells with checkerboard.
    const wellMask = unionMask(cs * 0.035, cs * 0.2);
    const wells = tinted(wellMask, (c) => {
      const g = c.createLinearGradient(0, oy, 0, oy + L.boardH);
      g.addColorStop(0, 'rgba(70,40,95,0.78)');
      g.addColorStop(1, 'rgba(48,24,70,0.84)');
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
          fg.addColorStop(1, 'rgba(255,220,255,0.06)');
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

    // Candies, clipped to the board so refills slide in from the top edge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox - cs * 0.3, oy - cs * 0.14, L.boardW + cs * 0.6, L.boardH + cs * 0.44);
    ctx.clip();
    const lifted: CandyVisual[] = [];
    for (const v of frame.visuals) {
      if (v.lift > 0.05) lifted.push(v);
      else this.drawCandy(ctx, v, frame.colorblindMode);
    }
    lifted.sort((a, b) => a.lift - b.lift);
    for (const v of lifted) this.drawCandy(ctx, v, frame.colorblindMode);
    for (const v of frame.dying) this.drawCandy(ctx, v, frame.colorblindMode);
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
  }

  private drawCandy(ctx: Ctx, v: CandyVisual, colorblind: boolean): void {
    if (v.alpha <= 0.01 || v.pop <= 0.01) return;
    const { cellSize: cs, originX: ox, originY: oy } = this.layout;
    const sprite = this.atlas.getCandy(v.candy);
    const cx = ox + (v.x + v.offsetX + 0.5) * cs;
    const cy = oy + (v.y + v.offsetY + 0.5) * cs - v.lift * cs * 0.07;
    const s = v.pop * (1 + 0.07 * v.lift);
    const anchor = cs * 0.36; // squash pivots near the candy's base
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, v.alpha));
    ctx.translate(cx, cy + anchor);
    if (v.rotation) ctx.rotate(v.rotation);
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
