/**
 * Sugar Snap — GameController.
 *
 * Owns the canvas, the rAF loop, input, spring physics and the sequential
 * playback of engine StepResult phases. The engine stays pure; this class
 * only animates what the engine already decided.
 */
import {
  applyHammerBooster,
  applyShuffleBooster,
  calculateStars,
  cloneGrid,
  executeSugarCrush,
  executeSwap,
  findValidMoves,
  isAdjacent,
} from '../engine';
import type {
  AnimationEvent,
  BoosterType,
  Candy,
  Cell,
  ChapterDef,
  GameState,
  GridPos,
  ObjectiveProgress,
  PraiseWord,
  ResolutionPhase,
  StepResult,
  ValidMove,
} from '../engine/types';
import type { ISoundEngine } from '../audio/soundTypes';
import type { ZenSaveState } from '../state/storageTypes';
import { BoardRenderer, type CandyVisual, type HintFx, type OozeFx } from './boardRenderer';
import { ParticleSystem, seekerFlightDuration } from './particles';
import { GOLD, candyColorHex } from './candySprites';

export interface GameControllerOptions {
  canvas: HTMLCanvasElement;
  initialState: GameState;
  chapter: ChapterDef;
  sound: ISoundEngine;
  colorblindMode: boolean;
  reducedMotion: boolean;
  onStateChange: (snapshot: {
    score: number;
    movesLeft: number;
    objectives: ObjectiveProgress[];
    status: GameState['status'];
    stars: 0 | 1 | 2 | 3;
    activeBooster: BoosterType | null;
    isAnimating: boolean;
  }) => void;
  onBoosterConsumed: (booster: BoosterType) => void;
  /** Fires as soon as the final win/loss state is computed (before finale animation ends) so progress persists immediately. */
  onLevelResolved?: (result: { won: boolean; score: number; stars: 0 | 1 | 2 | 3; maxCascade: number }) => void;
  onLevelEnd: (result: { won: boolean; score: number; stars: 0 | 1 | 2 | 3; maxCascade: number }) => void;
  /** Zen mode only: fires with a restorable snapshot each time a turn or booster settles. */
  onZenSnapshot?: (zen: ZenSaveState) => void;
}

interface Tween {
  elapsed: number;
  dur: number;
  update?: (p: number) => void;
  done?: () => void;
  resolve?: () => void;
}

type DieMode = 'pop' | 'collect' | 'melt';

interface Dying {
  v: CandyVisual;
  delay: number;
  t: number;
  dur: number;
  mode: DieMode;
  started: boolean;
  startY: number;
}

interface PointerTrack {
  id: number;
  startX: number;
  startY: number;
  cell: GridPos;
  wasSelected: boolean;
  swiped: boolean;
  /** Set when pointerdown hits a neighbor of an already-selected cell; committed on release if no swipe happens. */
  pendingTapSwap: GridPos | null;
  /** Started while the board was still settling: a swipe is buffered, a tap does nothing. */
  buffered: boolean;
}

/** One-slot early-swipe buffer: a swipe made while the board settles, replayed the instant it can be. */
interface BufferedSwap {
  from: GridPos;
  to: GridPos;
  expiresAt: number;
}

/** Bonus-round banner: the game's own word, matching the engine's choice not to emit a finale callout. */
const FINALE_BANNER = 'Sugar Snap!';
const HINT_DELAY = 4.5;
const SWIPE_THRESHOLD = 0.28;
/** How long an early swipe stays valid while the board finishes settling (ms). */
const SWIPE_BUFFER_MS = 400;
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SPRING_K = 520;
const SPRING_C = 15;
const ROT_K = 380;
const ROT_C = 14;
const POP_K = 300;
const POP_C = 16;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t: number) => t * t;
const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const keyOf = (p: GridPos) => `${p.row},${p.col}`;
const samePos = (a: GridPos | null, b: GridPos | null) => !!a && !!b && a.row === b.row && a.col === b.col;

export class GameController {
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: GameControllerOptions;
  private readonly sound: ISoundEngine;
  private readonly renderer: BoardRenderer;
  private readonly particles = new ParticleSystem();

  private state: GameState;
  private chapter: ChapterDef;
  private displayGrid: Cell[][];
  private displayScore: number;
  private displayMoves: number;
  private displayObjectives: ObjectiveProgress[];
  private displayStatus: GameState['status'];

  private visuals = new Map<number, CandyVisual>();
  private dying: Dying[] = [];
  private tweens: Tween[] = [];
  private oozes: OozeFx[] = [];

  private time = 0;
  private lastTs = 0;
  private rafId = 0;
  private running = false;
  private destroyed = false;
  private busy = 0;
  private generation = 0;
  private ended = false;

  private colorblindMode: boolean;
  private reducedMotion: boolean;
  private activeBooster: BoosterType | null = null;

  private selected: GridPos | null = null;
  private hover: GridPos | null = null;
  private hoverId: number | null = null;
  private pointer: PointerTrack | null = null;
  private bufferedSwap: BufferedSwap | null = null;
  private unlocked = false;

  private idle = 0;
  private hintMove: ValidMove | null | undefined = undefined;
  private hintStrength = 0;
  private hintSparkle = 0;
  private hintIds: [number, number] | null = null;

  private lastLandSound = -1;
  private lastJellySound = -1;
  private lastCrunchSound = -1;
  private burstsThisFrame = 0;
  private sugarCrushAnnounced = false;
  private sugarCrushResolved: GameState | null = null;
  private cometIndex = 0;

  private resizeObserver: ResizeObserver | null = null;

  constructor(options: GameControllerOptions) {
    this.opts = options;
    this.canvas = options.canvas;
    this.sound = options.sound;
    this.state = options.initialState;
    this.chapter = options.chapter;
    this.colorblindMode = options.colorblindMode;
    this.reducedMotion = options.reducedMotion;
    this.renderer = new BoardRenderer(this.canvas);
    this.renderer.setChapter(this.chapter);
    this.particles.setReducedMotion(this.reducedMotion);

    this.displayGrid = this.state.grid;
    this.displayScore = this.state.score;
    this.displayMoves = this.state.movesLeft;
    this.displayObjectives = this.state.objectives;
    this.displayStatus = this.state.status;

    const st = this.canvas.style;
    st.touchAction = 'none';
    st.userSelect = 'none';
    st.setProperty('-webkit-user-select', 'none');
    st.setProperty('-webkit-touch-callout', 'none');
    st.setProperty('-webkit-tap-highlight-color', 'transparent');

    this.rebuildVisuals(this.state.grid);
  }

  /* ===================================================================== */
  /* Public API                                                             */
  /* ===================================================================== */

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    c.addEventListener('pointermove', this.onPointerMove, { passive: false });
    c.addEventListener('pointerup', this.onPointerUp, { passive: false });
    c.addEventListener('pointercancel', this.onPointerCancel);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('contextmenu', this.preventDefault);
    c.addEventListener('touchstart', this.preventDefault, { passive: false });
    c.addEventListener('touchmove', this.preventDefault, { passive: false });
    c.addEventListener('gesturestart', this.preventDefault as EventListener);
    window.addEventListener('resize', this.onWindowResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(c);
    }
    this.resize();
    this.renderer.atlas.prewarm(this.state.level.colors);
    this.lastTs = 0;
    this.rafId = requestAnimationFrame(this.loop);
    this.playIntro();
    this.emit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.generation++;
    cancelAnimationFrame(this.rafId);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('contextmenu', this.preventDefault);
    c.removeEventListener('touchstart', this.preventDefault);
    c.removeEventListener('touchmove', this.preventDefault);
    c.removeEventListener('gesturestart', this.preventDefault as EventListener);
    window.removeEventListener('resize', this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.bufferedSwap = null;
    this.flushTweens();
    this.particles.clear();
    this.visuals.clear();
    this.dying = [];
  }

  resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 360;
    const h = rect.height || this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 360;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.renderer.setLayout(w, h, dpr, this.state.level.rows, this.state.level.cols);
    this.particles.setPixelRatio(dpr);
  }

  setDisplayOptions(opts: { colorblindMode: boolean; reducedMotion: boolean }): void {
    this.colorblindMode = opts.colorblindMode;
    this.reducedMotion = opts.reducedMotion;
    this.particles.setReducedMotion(opts.reducedMotion);
  }

  setActiveBooster(booster: BoosterType | null): void {
    if (booster === 'shuffle') {
      this.useShuffleBooster();
      return;
    }
    if (booster === this.activeBooster) return;
    if (booster && !this.canInteract()) return;
    if (booster) this.bufferedSwap = null;
    this.activeBooster = booster;
    this.deselect();
    this.idle = 0;
    this.emit();
  }

  /** Shuffles the board immediately. Returns false if it could not run right now. */
  useShuffleBooster(): boolean {
    if (!this.canInteract()) return false;
    let result: StepResult;
    try {
      result = applyShuffleBooster(this.state);
    } catch (err) {
      console.error('[GameController] shuffle failed', err);
      return false;
    }
    if (!result.valid) return false;
    if (this.activeBooster) this.activeBooster = null;
    this.bufferedSwap = null;
    this.deselect();
    this.sound.playBooster();
    this.opts.onBoosterConsumed('shuffle');
    void this.runResult(result);
    return true;
  }

  loadState(state: GameState, chapter: ChapterDef): void {
    this.generation++;
    this.flushTweens();
    this.tweens = [];
    this.dying = [];
    this.oozes = [];
    this.particles.clear();
    this.busy = 0;
    this.ended = false;
    this.sugarCrushAnnounced = false;
    this.selected = null;
    this.hover = null;
    this.hoverId = null;
    this.pointer = null;
    this.bufferedSwap = null;
    this.activeBooster = null;
    this.idle = 0;
    this.hintMove = undefined;
    this.hintIds = null;
    this.hintStrength = 0;

    this.state = state;
    this.chapter = chapter;
    this.renderer.setChapter(chapter);
    this.displayGrid = state.grid;
    this.displayScore = state.score;
    this.displayMoves = state.movesLeft;
    this.displayObjectives = state.objectives;
    this.displayStatus = state.status;
    this.rebuildVisuals(state.grid);
    if (this.running) {
      this.resize();
      this.renderer.atlas.prewarm(state.level.colors);
      this.playIntro();
    }
    this.emit();
  }

  /* ===================================================================== */
  /* Loop                                                                   */
  /* ===================================================================== */

  private loop = (ts: number): void => {
    if (!this.running || this.destroyed) return;
    const dt = this.lastTs ? Math.min(Math.max((ts - this.lastTs) / 1000, 0), 0.05) : 1 / 120;
    this.lastTs = ts;
    try {
      this.update(dt);
      this.draw();
    } catch (err) {
      console.error('[GameController] frame error', err);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.time += dt;
    this.burstsThisFrame = 0;

    // Tweens & scheduled callbacks (copy: callbacks may enqueue more).
    if (this.tweens.length) {
      const list = this.tweens.slice();
      for (const tw of list) {
        tw.elapsed += dt;
        if (tw.elapsed < 0) continue;
        const p = tw.dur > 0 ? Math.min(1, tw.elapsed / tw.dur) : 1;
        tw.update?.(p);
        if (p >= 1) {
          const i = this.tweens.indexOf(tw);
          if (i >= 0) this.tweens.splice(i, 1);
          tw.done?.();
          tw.resolve?.();
        }
      }
    }

    // Spring-damper squish physics, sub-stepped for stability at any frame rate.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const springs = (v: CandyVisual, popSpring: boolean) => {
      for (let s = 0; s < steps; s++) {
        v.velScaleX += (-SPRING_K * (v.scaleX - 1) - SPRING_C * v.velScaleX) * h;
        v.velScaleY += (-SPRING_K * (v.scaleY - 1) - SPRING_C * v.velScaleY) * h;
        v.scaleX += v.velScaleX * h;
        v.scaleY += v.velScaleY * h;
        v.velRotation += (-ROT_K * v.rotation - ROT_C * v.velRotation) * h;
        v.rotation += v.velRotation * h;
        if (popSpring) {
          v.velPop += (-POP_K * (v.pop - 1) - POP_C * v.velPop) * h;
          v.pop += v.velPop * h;
        }
      }
      v.lift += (v.liftTarget - v.lift) * Math.min(1, dt * 16);
    };
    for (const v of this.visuals.values()) {
      springs(v, true);
      if (v.flash > 0) v.flash = Math.max(0, v.flash - dt * 3.5);
      if (v.alpha < 1) v.alpha = Math.min(1, v.alpha + dt * 6);
    }

    // Dying candies.
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      springs(d.v, false);
      if (d.delay > 0) {
        d.delay -= dt;
        continue;
      }
      if (!d.started) {
        d.started = true;
        this.onDieStart(d);
      }
      d.t += dt / d.dur;
      const p = Math.min(1, d.t);
      const v = d.v;
      if (d.mode === 'pop') {
        v.pop = p < 0.35 ? 1 + 0.28 * easeOutCubic(p / 0.35) : 1.28 * (1 - easeInQuad((p - 0.35) / 0.65));
        v.flash = Math.max(0, 1 - p * 1.4);
        v.alpha = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
      } else if (d.mode === 'collect') {
        v.y = d.startY + 1.3 * p * p;
        v.pop = 1 + 0.25 * Math.sin(p * Math.PI);
        v.alpha = 1 - p;
        v.flash = 0.6 * (1 - p);
      } else {
        v.pop = 1 - easeInQuad(p) * 0.9;
        v.alpha = 1 - p;
      }
      if (p >= 1) this.dying.splice(i, 1);
    }

    this.particles.update(dt);
    this.updateHint(dt);
  }

  private draw(): void {
    let hint: HintFx | null = null;
    if (this.hintMove && this.hintStrength > 0.01) {
      hint = { a: this.hintMove.from, b: this.hintMove.to, strength: this.hintStrength };
    }
    this.renderer.render({
      time: this.time,
      grid: this.displayGrid,
      visuals: this.visuals.values(),
      dying: this.dying.map((d) => d.v),
      selected: this.selected,
      hover: this.hover,
      activeBooster: this.activeBooster,
      hint,
      oozes: this.oozes,
      colorblindMode: this.colorblindMode,
      reducedMotion: this.reducedMotion,
      particles: this.particles,
    });
  }

  /* ===================================================================== */
  /* Timing helpers                                                         */
  /* ===================================================================== */

  private tween(dur: number, update?: (p: number) => void, delay = 0, done?: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.tweens.push({ elapsed: -delay, dur, update, done, resolve });
    });
  }

  private wait(seconds: number): Promise<void> {
    return this.tween(Math.max(0, seconds));
  }

  private schedule(delay: number, fn: () => void): void {
    this.tweens.push({ elapsed: -Math.max(0, delay), dur: 0, done: fn });
  }

  /** Resolves every pending tween so stale async playback can exit cleanly. */
  private flushTweens(): void {
    const list = this.tweens;
    this.tweens = [];
    for (const tw of list) tw.resolve?.();
  }

  /* ===================================================================== */
  /* Visual bookkeeping                                                     */
  /* ===================================================================== */

  private makeVisual(candy: Candy, row: number, col: number): CandyVisual {
    return {
      id: candy.id,
      candy,
      x: col,
      y: row,
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      velScaleX: 0,
      velScaleY: 0,
      rotation: 0,
      velRotation: 0,
      lift: 0,
      liftTarget: 0,
      pop: 1,
      velPop: 0,
      alpha: 1,
      flash: 0,
      dying: false,
    };
  }

  private rebuildVisuals(grid: Cell[][]): void {
    this.visuals.clear();
    for (const row of grid) {
      for (const cell of row) {
        if (cell.candy) this.visuals.set(cell.candy.id, this.makeVisual(cell.candy, cell.row, cell.col));
      }
    }
  }

  private visualAt(pos: GridPos): CandyVisual | undefined {
    const id = this.displayGrid[pos.row]?.[pos.col]?.candy?.id;
    return id === undefined ? undefined : this.visuals.get(id);
  }

  private kill(v: CandyVisual, mode: DieMode, delay: number): void {
    if (v.dying) return;
    this.visuals.delete(v.id);
    v.dying = true;
    v.liftTarget = 0;
    if (this.hoverId === v.id) this.hoverId = null;
    this.dying.push({ v, delay, t: 0, dur: mode === 'pop' ? 0.24 : mode === 'collect' ? 0.5 : 0.3, mode, started: false, startY: v.y });
  }

  private onDieStart(d: Dying): void {
    const c = this.renderer.cellCenter(d.v.y, d.v.x);
    const cs = this.renderer.cellSize;
    const color = d.v.candy.ingredient ? GOLD : candyColorHex(d.v.candy.color);
    if (d.mode === 'pop') {
      this.burstsThisFrame++;
      const heavy = this.burstsThisFrame > 14;
      this.particles.jellyBurst(c.x, c.y, color, heavy ? 3 : 8, 1, cs);
      this.particles.sparkle(c.x, c.y, heavy ? 1 : 3, '#ffffff', cs * 0.3, cs * 1.2);
      if (d.v.candy.special !== 'none' && !heavy) this.particles.shockwave(c.x, c.y, cs * 0.9, color, 6, 0.3);
    } else if (d.mode === 'collect') {
      this.particles.sparkle(c.x, c.y, 10, GOLD, cs * 0.4, cs * 1.5);
      this.particles.shockwave(c.x, c.y, cs * 1.1, GOLD, 7, 0.4);
    }
  }

  /** Make the visual set match a grid: create missing, retarget changed, pop removed. */
  private syncVisuals(grid: Cell[][]): void {
    const seen = new Set<number>();
    for (const row of grid) {
      for (const cell of row) {
        const candy = cell.candy;
        if (!candy) continue;
        seen.add(candy.id);
        let v = this.visuals.get(candy.id);
        if (!v) {
          v = this.makeVisual(candy, cell.row, cell.col);
          v.pop = 0.2;
          v.velPop = 4;
          this.visuals.set(candy.id, v);
          continue;
        }
        if (v.candy.special !== candy.special || v.candy.color !== candy.color || v.candy.ingredient !== candy.ingredient) {
          v.flash = Math.max(v.flash, 0.9);
          v.velPop += 6;
        }
        v.candy = candy;
        if (Math.abs(v.x - cell.col) > 0.001 || Math.abs(v.y - cell.row) > 0.001) {
          const sx = v.x;
          const sy = v.y;
          const tx = cell.col;
          const ty = cell.row;
          const target = v;
          void this.tween(0.12, (p) => {
            const e = easeOutCubic(p);
            target.x = sx + (tx - sx) * e;
            target.y = sy + (ty - sy) * e;
          });
        }
      }
    }
    for (const v of Array.from(this.visuals.values())) {
      if (!seen.has(v.id)) this.kill(v, 'pop', 0);
    }
  }

  private placeCandy(pos: GridPos, candy: Candy, celebrate: boolean): void {
    const cell = this.displayGrid[pos.row]?.[pos.col];
    if (cell) cell.candy = candy;
    let v = this.visuals.get(candy.id);
    if (!v) {
      v = this.makeVisual(candy, pos.row, pos.col);
      v.pop = 0.15;
      this.visuals.set(candy.id, v);
    } else {
      v.candy = candy;
      v.x = pos.col;
      v.y = pos.row;
    }
    if (celebrate) {
      v.velPop += 9;
      v.flash = 1;
      v.velScaleY += 4 * this.motionK();
    }
  }

  private motionK(): number {
    return this.reducedMotion ? 0.4 : 1;
  }

  /* ===================================================================== */
  /* Playback                                                               */
  /* ===================================================================== */

  private async runResult(result: StepResult, fallbackSwap?: { from: GridPos; to: GridPos }): Promise<void> {
    const gen = this.generation;
    this.busy++;
    this.idle = 0;
    this.hintMove = undefined;
    if (result.valid) this.displayMoves = result.state.movesLeft;
    this.emit();
    try {
      if (!result.valid && fallbackSwap && !result.phases.some((p) => p.kind === 'swap')) {
        await this.animSwap(fallbackSwap.from, fallbackSwap.to, false);
      }
      await this.playPhases(result.phases, gen);
      if (gen !== this.generation) return;
      this.state = result.state;
      this.displayStatus = this.state.status === 'sugar-crush' ? 'sugar-crush' : 'playing';
      await this.afterResolve(gen);
    } catch (err) {
      console.error('[GameController] playback failed', err);
      if (gen === this.generation) this.state = result.state;
    } finally {
      if (gen === this.generation) {
        this.busy = Math.max(0, this.busy - 1);
        this.finalSync();
        if (!this.ended && (this.state.status === 'won' || this.state.status === 'lost')) this.finish();
        this.emit();
        if (result.valid) this.emitZenSnapshot();
        this.drainBufferedSwap();
      }
    }
  }

  /** Zen mode: hand the settled board to the host so endless play survives a reload. */
  private emitZenSnapshot(): void {
    if (this.busy > 0 || this.state.level.mode !== 'zen' || !this.opts.onZenSnapshot) return;
    try {
      this.opts.onZenSnapshot({
        grid: cloneGrid(this.state.grid),
        score: this.state.score,
        maxCascade: this.state.maxCascade,
        totalMovesMade: this.state.totalMovesMade,
        nextCandyId: this.state.nextCandyId,
      });
    } catch (err) {
      console.error('[GameController] onZenSnapshot threw', err);
    }
  }

  /** Replays a swipe made while the board was settling, if it is still fresh. */
  private drainBufferedSwap(): void {
    const b = this.bufferedSwap;
    if (!b) return;
    this.bufferedSwap = null;
    if (nowMs() > b.expiresAt || !this.canInteract() || this.activeBooster === 'hammer') return;
    this.deselect();
    this.attemptSwap(b.from, b.to);
  }

  /** Immediately finishes an in-progress Sugar Snap bonus cascade, awarding the full resolved score. */
  skipSugarCrush(): void {
    if (!this.sugarCrushResolved || this.ended || this.destroyed) return;
    const resolved = this.sugarCrushResolved;
    this.sugarCrushResolved = null;
    this.generation++;
    this.tweens = [];
    this.dying = [];
    this.oozes = [];
    this.bufferedSwap = null;
    this.busy = 0;
    this.state = resolved;
    this.finalSync();
    this.finish();
  }

  private async afterResolve(gen: number): Promise<void> {
    if (this.state.status === 'sugar-crush') {
      const crushRuns: StepResult[] = [];
      let resolvedState = this.state;
      let guard = 0;
      while (resolvedState.status === 'sugar-crush' && guard < 4) {
        guard++;
        try {
          const crush = executeSugarCrush(resolvedState);
          crushRuns.push(crush);
          resolvedState = crush.state;
        } catch (err) {
          console.error('[GameController] sugar crush failed', err);
          break;
        }
      }
      if (resolvedState.status === 'sugar-crush') resolvedState = { ...resolvedState, status: 'won' };
      this.sugarCrushResolved = resolvedState;
      // Persist the earned win immediately so leaving via Map/Retry mid-finale never discards progress.
      const finalScore = resolvedState.score;
      const finalStars = calculateStars(finalScore, resolvedState.level.starThresholds);
      this.opts.onLevelResolved?.({
        won: resolvedState.status === 'won',
        score: finalScore,
        stars: finalStars,
        maxCascade: resolvedState.maxCascade,
      });

      for (let i = 0; i < crushRuns.length; i++) {
        if (!this.sugarCrushAnnounced) this.showFinale();
        this.displayStatus = 'sugar-crush';
        this.emit();
        await this.wait(i === 0 ? 0.35 : 0.12);
        if (gen !== this.generation) return;
        await this.playPhases(crushRuns[i].phases, gen);
        if (gen !== this.generation) return;
      }
      this.sugarCrushResolved = null;
      this.state = resolvedState;
    } else if (this.state.status === 'won' || this.state.status === 'lost') {
      const score = this.state.score;
      const stars = calculateStars(score, this.state.level.starThresholds);
      this.opts.onLevelResolved?.({
        won: this.state.status === 'won',
        score,
        stars,
        maxCascade: this.state.maxCascade,
      });
    }
  }

  private finalSync(): void {
    this.displayGrid = this.state.grid;
    this.displayScore = this.state.score;
    this.displayMoves = this.state.movesLeft;
    this.displayObjectives = this.state.objectives;
    this.displayStatus = this.state.status;
    this.oozes = [];
    this.syncVisuals(this.state.grid);
    this.hintMove = undefined;
  }

  private finish(): void {
    this.ended = true;
    this.bufferedSwap = null;
    this.activeBooster = null;
    this.deselect();
    const score = this.state.score;
    const stars = calculateStars(score, this.state.level.starThresholds);
    this.emit();
    this.opts.onLevelEnd({ won: this.state.status === 'won', score, stars, maxCascade: this.state.maxCascade });
  }

  private async playPhases(phases: ResolutionPhase[], gen: number): Promise<void> {
    for (const ph of phases) {
      if (gen !== this.generation) return;
      switch (ph.kind) {
        case 'swap':
          await this.animSwapPhase(ph);
          break;
        case 'gravity':
          await this.animGravity(ph);
          break;
        case 'chocolate':
          await this.animChocolate(ph);
          break;
        case 'shuffle':
          await this.animShuffle(ph);
          break;
        default:
          await this.animClear(ph);
      }
      if (gen !== this.generation) return;
      this.commitPhase(ph);
    }
  }

  private commitPhase(ph: ResolutionPhase): void {
    this.displayGrid = ph.gridAfter;
    this.displayScore = ph.scoreAfter;
    this.displayObjectives = ph.objectivesAfter;
    this.syncVisuals(ph.gridAfter);
    this.emit();
  }

  /* ------------------------------- swap -------------------------------- */

  private async animSwapPhase(ph: ResolutionPhase): Promise<void> {
    for (const e of ph.events) {
      if (e.type === 'swap') await this.animSwap(e.from, e.to, e.valid);
      else this.handleMisc(e, 0);
    }
  }

  private async animSwap(from: GridPos, to: GridPos, valid: boolean): Promise<void> {
    const a = this.visualAt(from);
    const b = this.visualAt(to);
    const k = this.motionK();
    const move = (v: CandyVisual | undefined, s: GridPos, t: GridPos, e: number, arc: number) => {
      if (!v) return;
      v.x = s.col + (t.col - s.col) * e;
      v.y = s.row + (t.row - s.row) * e;
      v.offsetY = arc;
    };
    if (a) a.liftTarget = 1;
    if (valid) {
      this.sound.playSwap();
      await this.tween(0.15, (p) => {
        const e = easeInOutCubic(p);
        const arc = -Math.sin(Math.PI * p) * 0.1 * k;
        move(a, from, to, e, arc);
        move(b, to, from, e, -arc * 0.4);
      });
      for (const v of [a, b]) {
        if (!v) continue;
        v.offsetY = 0;
        v.liftTarget = 0;
        v.velScaleX += 2.6 * k;
        v.velScaleY -= 2.6 * k;
      }
      return;
    }
    this.sound.playInvalidSwap();
    await this.tween(0.12, (p) => {
      const e = easeInOutCubic(p) * 0.92;
      move(a, from, to, e, -Math.sin(Math.PI * p) * 0.08 * k);
      move(b, to, from, e, 0);
    });
    const dir = Math.sign(to.col - from.col) || Math.sign(to.row - from.row);
    await this.tween(0.14, (p) => {
      const e = 0.92 * (1 - easeOutBack(p));
      move(a, from, to, e, 0);
      move(b, to, from, e, 0);
    });
    for (const v of [a, b]) {
      if (!v) continue;
      move(v, v === a ? from : to, v === a ? from : to, 0, 0);
      v.liftTarget = 0;
      v.velScaleX += 4.5 * k;
      v.velScaleY -= 3.8 * k;
      v.velRotation += (v === a ? 7 : -7) * dir * k;
    }
  }

  /* ------------------------------- clear ------------------------------- */

  private async animClear(ph: ResolutionPhase): Promise<void> {
    const before = this.displayGrid;
    this.displayGrid = cloneGrid(before);
    const after = ph.gridAfter;
    const cs = this.renderer.cellSize;
    const L = this.renderer.getLayout();
    const rows = before.length;
    const cols = rows ? before[0].length : 0;
    const k = this.motionK();
    const afterIds = new Set<number>();
    for (const row of after) for (const c of row) if (c.candy) afterIds.add(c.candy.id);

    const offset = ph.kind === 'wrapped-second' ? 0.12 : 0;
    const posDelay = new Map<string, number>();
    const setPos = (p: GridPos, d: number) => {
      const key = keyOf(p);
      const cur = posDelay.get(key);
      if (cur === undefined || d < cur) posDelay.set(key, d);
    };
    const collectIds = new Set<number>();
    const hasPopups = ph.events.some((e) => e.type === 'score-popup');
    let maxT = 0;
    const at = (d: number, fn: () => void) => {
      const t = d + offset;
      maxT = Math.max(maxT, t);
      this.schedule(t, fn);
    };

    // Pass 0: Sugar Bee flights. Each bee launches on a short stagger and lands
    // after its flight; payload blasts at the landing cell wait for the bee.
    const seekerLaunch = new Map<AnimationEvent, number>();
    const seekerArrive = new Map<string, number>();
    let seekerIdx = 0;
    for (const e of ph.events) {
      if (e.type !== 'seeker-fly') continue;
      const launch = 0.04 + Math.min(seekerIdx, 12) * 0.05;
      seekerIdx++;
      const o = this.renderer.cellCenter(e.origin.row, e.origin.col);
      const t = this.renderer.cellCenter(e.target.row, e.target.col);
      const arrive = launch + seekerFlightDuration(o.x, o.y, t.x, t.y, cs);
      seekerLaunch.set(e, launch);
      const key = keyOf(e.target);
      seekerArrive.set(key, Math.max(seekerArrive.get(key) ?? 0, arrive));
    }
    const lead = (p: GridPos): number => seekerArrive.get(keyOf(p)) ?? 0;

    // Pass 1: timing for every affected cell.
    for (const e of ph.events) {
      switch (e.type) {
        case 'match':
          for (const c of e.cells) setPos(c, 0);
          break;
        case 'laser': {
          const l = lead(e.origin);
          for (const p of e.affected) {
            const dist = e.orientation === 'h' ? Math.abs(p.col - e.origin.col) : Math.abs(p.row - e.origin.row);
            setPos(p, l + 0.03 + dist * 0.022);
          }
          setPos(e.origin, l);
          break;
        }
        case 'wrapped-boom': {
          const l = lead(e.center);
          for (const p of e.affected) setPos(p, l + 0.03 + Math.max(Math.abs(p.row - e.center.row), Math.abs(p.col - e.center.col)) * 0.035);
          break;
        }
        case 'seeker-fly':
          setPos(e.origin, seekerLaunch.get(e) ?? 0);
          setPos(e.target, seekerArrive.get(keyOf(e.target)) ?? 0);
          break;
        case 'lightning': {
          const step = Math.min(0.035, 0.55 / Math.max(1, e.targets.length));
          e.targets.forEach((p, i) => setPos(p, i * step + (e.convertTo ? 0.32 : 0.06)));
          setPos(e.origin, e.targets.length * step + (e.convertTo ? 0.36 : 0.08));
          break;
        }
        case 'board-wipe':
          for (const p of e.affected) setPos(p, 0.08 + Math.hypot(p.row - e.origin.row, p.col - e.origin.col) * 0.03);
          setPos(e.origin, 0);
          break;
        case 'booster-hammer':
          setPos(e.pos, 0.08);
          break;
        default:
          break;
      }
    }

    // Pass 2: effects and sound, in sync with that timing.
    let matchCells = 0;
    let maxCascade = 1;
    for (const e of ph.events) {
      switch (e.type) {
        case 'match': {
          matchCells += e.cells.length;
          maxCascade = Math.max(maxCascade, e.cascade);
          if (!hasPopups && e.points > 0 && e.cells.length) {
            const cr = e.cells.reduce((s, c) => s + c.row, 0) / e.cells.length;
            const cc = e.cells.reduce((s, c) => s + c.col, 0) / e.cells.length;
            const pt = this.renderer.cellCenter(cr, cc);
            const col = candyColorHex(e.color);
            at(0.1, () => this.particles.scorePopup(pt.x, pt.y, e.points, col, cs * 0.42));
          }
          break;
        }
        case 'special-spawn':
          at(0.13, () => {
            this.placeCandy(e.pos, e.candy, true);
            this.sound.playSpecialSpawn(e.candy.special);
            const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
            const col = e.candy.color === 'none' ? GOLD : candyColorHex(e.candy.color);
            this.particles.sparkle(c.x, c.y, 10, '#ffffff', cs * 0.45, cs * 1.4);
            this.particles.shockwave(c.x, c.y, cs * 0.95, col, 7, 0.35);
          });
          break;
        case 'laser': {
          const width = e.width ?? 1;
          const color = e.color === 'none' ? GOLD : candyColorHex(e.color);
          at(lead(e.origin), () => {
            const o = this.renderer.cellCenter(e.origin.row, e.origin.col);
            const lanes = width === 3 ? [-1, 0, 1] : [0];
            for (const lane of lanes) {
              if (e.orientation === 'h') {
                const r = e.origin.row + lane;
                if (r < 0 || r >= rows) continue;
                const y = this.renderer.cellCenter(r, 0).y;
                this.particles.laser(o.x, y, L.originX - cs * 0.35, y, L.originX + L.boardW + cs * 0.35, y, color, cs * (lane === 0 ? 0.34 : 0.26));
              } else {
                const c = e.origin.col + lane;
                if (c < 0 || c >= cols) continue;
                const x = this.renderer.cellCenter(0, c).x;
                this.particles.laser(x, o.y, x, L.originY - cs * 0.35, x, L.originY + L.boardH + cs * 0.35, color, cs * (lane === 0 ? 0.34 : 0.26));
              }
            }
            this.sound.playStripedBlast(width === 3);
            this.particles.shake((width === 3 ? 7 : 4) * k);
            this.particles.flash(width === 3 ? 0.14 : 0.07, '#ffffff');
          });
          break;
        }
        case 'wrapped-boom': {
          const color = e.color === 'none' ? GOLD : candyColorHex(e.color);
          if (ph.kind === 'wrapped-second' && e.stage === 2) {
            const v = this.visualAt(e.center);
            if (v) {
              v.velPop += 7 * k;
              v.flash = 0.9;
            }
          }
          at(lead(e.center), () => {
            const c = this.renderer.cellCenter(e.center.row, e.center.col);
            this.particles.shockwave(c.x, c.y, cs * (e.radius * 1.5 + 0.9), color, 13, 0.5);
            this.particles.shockwave(c.x, c.y, cs * (e.radius * 0.9 + 0.5), '#ffffff', 7, 0.32);
            this.particles.jellyBurst(c.x, c.y, color, 16, 1.4, cs);
            this.particles.sparkle(c.x, c.y, 10, '#fff4c2', cs * 0.8, cs * 2);
            this.particles.flash(e.radius === 2 ? 0.22 : 0.12, '#fff2d6');
            this.particles.shake((e.radius === 2 ? 10 : 6) * k);
            this.sound.playWrappedBlast(e.stage, e.radius === 2);
          });
          break;
        }
        case 'lightning': {
          const step = Math.min(0.035, 0.55 / Math.max(1, e.targets.length));
          const color: string = e.color === 'none' ? 'rainbow' : candyColorHex(e.color);
          e.targets.forEach((p, i) => {
            at(i * step, () => {
              const o = this.renderer.cellCenter(e.origin.row, e.origin.col);
              const t = this.renderer.cellCenter(p.row, p.col);
              this.particles.lightning(o.x, o.y, t.x, t.y, color, 0.3);
              if (i < 10 || i % 3 === 0) this.sound.playColorBombZap(i);
              const v = this.anyVisualAt(before, p);
              if (v) {
                v.flash = 1;
                v.velScaleX += 3 * k;
                v.velScaleY -= 3 * k;
                if (e.convertTo && v.candy.color !== 'none') {
                  const special =
                    e.convertTo === 'wrapped' ? 'wrapped' : e.convertTo === 'seeker' ? 'seeker' : i % 2 === 0 ? 'striped-h' : 'striped-v';
                  v.candy = { ...v.candy, special };
                  v.velPop += 6;
                }
              }
            });
          });
          at(0, () => {
            const v = this.anyVisualAt(before, e.origin);
            if (v) {
              v.velRotation += 10 * k;
              v.flash = 0.8;
            }
            this.particles.flash(0.08, '#ffffff');
          });
          break;
        }
        case 'seeker-fly': {
          const launch = seekerLaunch.get(e) ?? 0.04;
          const arrive = seekerArrive.get(keyOf(e.target)) ?? launch + 0.34;
          maxT = Math.max(maxT, offset + arrive);
          at(launch, () => this.launchSeeker(e, before));
          break;
        }
        case 'board-wipe':
          at(0, () => {
            const o = this.renderer.cellCenter(e.origin.row, e.origin.col);
            this.sound.playBoardWipe();
            this.particles.flash(0.4, '#ffffff');
            this.particles.shake(13 * k);
            this.particles.shockwave(o.x, o.y, cs * Math.max(rows, cols) * 1.1, GOLD, 18, 0.8);
            this.particles.shockwave(o.x, o.y, cs * Math.max(rows, cols) * 0.6, '#ff8fd0', 10, 0.6);
            const picks = e.affected.slice().sort(() => Math.random() - 0.5).slice(0, this.reducedMotion ? 5 : 14);
            picks.forEach((p, i) => {
              this.schedule(i * 0.03, () => {
                const t = this.renderer.cellCenter(p.row, p.col);
                this.particles.lightning(o.x, o.y, t.x, t.y, 'rainbow', 0.35);
              });
            });
          });
          break;
        case 'blocker-hit': {
          const d = posDelay.get(keyOf(e.pos)) ?? 0.05;
          at(d, () => {
            const cell = this.displayGrid[e.pos.row]?.[e.pos.col];
            const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
            if (e.blocker === 'frosting') {
              if (cell) cell.frosting = Math.max(0, Math.min(3, e.remaining)) as 0 | 1 | 2 | 3;
              this.crunch();
              this.particles.jellyBurst(c.x, c.y, '#ffffff', 9, 0.9, cs);
              this.particles.jellyBurst(c.x, c.y, '#e9e0ff', 4, 0.7, cs);
              this.particles.sparkle(c.x, c.y, 5, '#ffffff', cs * 0.4, cs);
            } else if (e.blocker === 'lock') {
              if (cell) cell.locked = e.remaining > 0;
              this.sound.playLockBreak();
              this.particles.jellyBurst(c.x, c.y, '#3a1a2c', 10, 1.1, cs);
              this.particles.sparkle(c.x, c.y, 4, '#ffc4e4', cs * 0.4, cs);
            } else {
              if (cell) cell.chocolate = e.remaining > 0;
              this.crunch();
              this.particles.jellyBurst(c.x, c.y, '#6e3d22', 11, 1, cs);
              this.particles.jellyBurst(c.x, c.y, '#b37a52', 4, 0.8, cs);
            }
          });
          break;
        }
        case 'jelly-clear': {
          const d = (posDelay.get(keyOf(e.pos)) ?? 0.02) + 0.03;
          at(d, () => {
            const cell = this.displayGrid[e.pos.row]?.[e.pos.col];
            if (cell) cell.jelly = e.remaining;
            if (this.time - this.lastJellySound > 0.07) {
              this.lastJellySound = this.time;
              this.sound.playJellyClear();
            }
            const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
            this.particles.jellyBurst(c.x, c.y, '#ff7ab8', 6, 0.8, cs);
            this.particles.shockwave(c.x, c.y, cs * 0.75, '#ff9ccc', 5, 0.3);
          });
          break;
        }
        case 'ingredient-collect':
          collectIds.add(e.candyId);
          at(0.04, () => this.sound.playIngredientCollect());
          break;
        case 'callout':
          at(0.08, () => this.showCallout(e.text));
          break;
        case 'booster-hammer':
          at(0, () => {
            const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
            this.sound.playBooster();
            this.particles.shake(10 * k);
            this.particles.flash(0.16, '#fff1d0');
            this.particles.shockwave(c.x, c.y, cs * 1.5, GOLD, 12, 0.45);
            this.particles.sparkle(c.x, c.y, 12, GOLD, cs * 0.5, cs * 2);
            const v = this.anyVisualAt(before, e.pos);
            if (v) {
              v.velScaleY -= 9 * k;
              v.velScaleX += 7 * k;
              v.flash = 1;
            }
          });
          break;
        case 'score-popup': {
          const d = (posDelay.get(keyOf(e.pos)) ?? 0) + 0.1;
          const col = candyColorHex(e.color);
          at(d, () => {
            const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
            this.particles.scorePopup(c.x, c.y, e.points, col, cs * (e.points >= 1000 ? 0.5 : 0.42));
          });
          break;
        }
        case 'sugar-crush-comet': {
          const idx = this.cometIndex++;
          const delay = (idx % 24) * 0.07;
          const tgt = this.renderer.cellCenter(e.to.row, e.to.col);
          const fromX = L.originX + L.boardW / 2 + (Math.random() - 0.5) * cs * 2;
          const fromY = Math.max(-cs * 0.5, L.originY - cs * 1.6);
          maxT = Math.max(maxT, offset + delay + 0.55);
          this.particles.comet(fromX, fromY, tgt.x, tgt.y, GOLD, 0.5, delay, () => {
            if (this.destroyed) return;
            this.placeCandy(e.to, e.candy, true);
            this.sound.playSpecialSpawn(e.candy.special);
          });
          break;
        }
        default:
          this.handleMisc(e, offset);
      }
    }
    this.cometIndex = 0;

    if (matchCells > 0) this.sound.playMatch(maxCascade, matchCells);

    // Pop every candy that is gone after this phase, staggered by its cell's timing.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const candy = before[r][c].candy;
        if (!candy || afterIds.has(candy.id)) continue;
        const v = this.visuals.get(candy.id);
        if (!v) continue;
        if (collectIds.has(candy.id)) {
          this.kill(v, 'collect', offset);
          continue;
        }
        const d = (posDelay.get(`${r},${c}`) ?? 0) + offset;
        maxT = Math.max(maxT, d);
        this.kill(v, 'pop', d);
      }
    }

    const base = ph.kind === 'combo' ? 0.32 : ph.kind === 'wrapped-second' ? 0.28 : ph.kind === 'sugar-crush' ? 0.26 : 0.22;
    await this.wait(Math.max(base, maxT + 0.2));
  }

  /** Finds a candy's visual by its position in `grid`, whether it is alive or already popping. */
  private anyVisualAt(grid: Cell[][], pos: GridPos): CandyVisual | undefined {
    const id = grid[pos.row]?.[pos.col]?.candy?.id;
    if (id === undefined) return undefined;
    return this.visuals.get(id) ?? this.dying.find((d) => d.v.id === id)?.v;
  }

  /** Sends a glossy Sugar Bee swooping from its candy to the target cell. */
  private launchSeeker(e: Extract<AnimationEvent, { type: 'seeker-fly' }>, grid: Cell[][]): void {
    const cs = this.renderer.cellSize;
    const k = this.motionK();
    const o = this.renderer.cellCenter(e.origin.row, e.origin.col);
    const t = this.renderer.cellCenter(e.target.row, e.target.col);
    const color = candyColorHex(e.color);
    const src = this.anyVisualAt(grid, e.origin);
    if (src) {
      src.flash = 1;
      src.velScaleY += 5 * k;
      src.velScaleX -= 3 * k;
    }
    this.particles.seekerFlight(o.x, o.y, t.x, t.y, color, cs, e.payload ?? 'none', () => {
      if (this.destroyed) return;
      this.particles.shake((e.payload && e.payload !== 'none' ? 5 : 2.5) * k);
      const v = this.anyVisualAt(grid, e.target);
      if (v) {
        v.flash = 1;
        v.velScaleY -= 4 * k;
        v.velScaleX += 3.5 * k;
      }
    });
    this.sound.playSeekerLaunch();
  }

  private crunch(): void {
    if (this.time - this.lastCrunchSound > 0.06) {
      this.lastCrunchSound = this.time;
      this.sound.playFrostingCrunch();
    }
  }

  /** Events that can appear in any phase. */
  private handleMisc(e: AnimationEvent, delay: number): void {
    const cs = this.renderer.cellSize;
    if (e.type === 'callout') {
      this.schedule(delay + 0.05, () => this.showCallout(e.text));
    } else if (e.type === 'score-popup') {
      const col = candyColorHex(e.color);
      this.schedule(delay + 0.05, () => {
        const c = this.renderer.cellCenter(e.pos.row, e.pos.col);
        this.particles.scorePopup(c.x, c.y, e.points, col, cs * 0.42);
      });
    } else if (e.type === 'ingredient-collect') {
      const v = this.visuals.get(e.candyId);
      if (v) this.kill(v, 'collect', delay);
      this.schedule(delay, () => this.sound.playIngredientCollect());
    } else if (e.type === 'seeker-fly') {
      const grid = this.displayGrid;
      this.schedule(delay + 0.04, () => this.launchSeeker(e, grid));
    }
  }

  /** Renders whatever praise word the engine emits; the words themselves are the engine's call. */
  private showCallout(text: PraiseWord): void {
    const finale = text === 'Sugar Snap!';
    if (finale && this.sugarCrushAnnounced) return;
    if (finale) this.sugarCrushAnnounced = true;
    const L = this.renderer.getLayout();
    this.sound.playCallout(text);
    this.particles.callout(text, L.originX + L.boardW / 2, L.originY + L.boardH * 0.42, Math.min(L.cellSize * 1.05, L.boardW / 6), finale);
    if (finale) {
      this.particles.flash(0.25, '#ffe9a8');
      this.particles.shake(6 * this.motionK());
    }
  }

  /** Our own end-of-level banner, shown when the bonus round starts (the engine emits no finale callout). */
  private showFinale(): void {
    this.sugarCrushAnnounced = true;
    const L = this.renderer.getLayout();
    this.particles.callout(FINALE_BANNER, L.originX + L.boardW / 2, L.originY + L.boardH * 0.42, Math.min(L.cellSize * 1.05, L.boardW / 6), true);
    this.particles.flash(0.25, '#ffe9a8');
    this.particles.shake(6 * this.motionK());
    this.particles.sparkle(L.originX + L.boardW / 2, L.originY + L.boardH * 0.42, 24, GOLD, L.boardW * 0.3, L.cellSize * 2.5);
    this.sound.playBoardWipe();
  }

  /* ------------------------------ gravity ------------------------------ */

  private async animGravity(ph: ResolutionPhase): Promise<void> {
    const moves: Extract<AnimationEvent, { type: 'gravity' }>['moves'] = [];
    for (const e of ph.events) {
      if (e.type === 'gravity') moves.push(...e.moves);
      else this.handleMisc(e, 0);
    }
    if (!moves.length) {
      await this.wait(0.05);
      return;
    }
    const rows = this.state.level.rows;
    const k = this.motionK();

    // Stack fresh candies above their column so they fall in as a column.
    const newByCol = new Map<number, typeof moves>();
    for (const m of moves) {
      if (!m.isNew) continue;
      const list = newByCol.get(m.to.col) ?? [];
      list.push(m);
      newByCol.set(m.to.col, list);
    }
    const spawnRow = new Map<number, number>();
    for (const list of newByCol.values()) {
      list.sort((a, b) => b.to.row - a.to.row);
      list.forEach((m, i) => spawnRow.set(m.candyId, m.from.row < 0 && m.from.row < m.to.row ? m.from.row : -1 - i));
    }

    let landings = 0;
    let maxEnd = 0;
    for (const m of moves) {
      let v = this.visuals.get(m.candyId);
      let sx: number;
      let sy: number;
      if (!v || m.isNew) {
        sy = spawnRow.get(m.candyId) ?? Math.min(m.from.row, -1);
        sx = m.from.col;
        if (!v) {
          v = this.makeVisual(m.candy, sy, sx);
          this.visuals.set(m.candyId, v);
        } else {
          v.x = sx;
          v.y = sy;
        }
      } else {
        sx = v.x;
        sy = v.y;
      }
      v.candy = m.candy;
      const target = v;
      const dist = Math.max(0.5, Math.hypot(m.to.row - sy, m.to.col - sx));
      const dur = Math.min(0.34, 0.19 + 0.03 * dist);
      const delay = (rows - 1 - m.to.row) * 0.012 + (m.isNew ? 0.025 : 0) + m.to.col * 0.004;
      maxEnd = Math.max(maxEnd, delay + dur);
      target.velScaleY += 1.2 * k;
      void this.tween(
        dur,
        (p) => {
          const e = easeInQuad(p);
          target.x = sx + (m.to.col - sx) * e;
          target.y = sy + (m.to.row - sy) * e;
        },
        delay,
        () => {
          target.x = m.to.col;
          target.y = m.to.row;
          const impact = Math.min(1, dist / 5);
          target.velScaleY -= (3.2 + impact * 4.5) * k;
          target.velScaleX += (2.6 + impact * 3.4) * k;
          landings++;
          if (this.time - this.lastLandSound > 0.06 && landings <= 6) {
            this.lastLandSound = this.time;
            this.sound.playLand(Math.min(1, 0.35 + impact * 0.5 + moves.length / 40));
          }
        },
      );
    }
    await this.wait(maxEnd + 0.05);
  }

  /* ----------------------------- chocolate ----------------------------- */

  private async animChocolate(ph: ResolutionPhase): Promise<void> {
    let spread = false;
    const mine: OozeFx[] = [];
    for (const e of ph.events) {
      if (e.type === 'chocolate-spread') {
        spread = true;
        const o: OozeFx = { from: e.from, to: e.to, t: 0 };
        mine.push(o);
        this.oozes.push(o);
        const v = this.visualAt(e.to);
        if (v) this.kill(v, 'melt', 0.12);
      } else {
        this.handleMisc(e, 0);
      }
    }
    if (!spread) {
      await this.wait(0.05);
      return;
    }
    this.sound.playChocolateSpread();
    await this.tween(0.28, (p) => {
      for (const o of mine) o.t = p;
    });
    this.oozes = this.oozes.filter((o) => !mine.includes(o));
  }

  /* ------------------------------ shuffle ------------------------------ */

  private async animShuffle(ph: ResolutionPhase): Promise<void> {
    const maps: Array<{ v: CandyVisual; fx: number; fy: number; tx: number; ty: number }> = [];
    for (const e of ph.events) {
      if (e.type === 'shuffle') {
        for (const m of e.mappings) {
          const v = this.visuals.get(m.candyId);
          if (v) maps.push({ v, fx: v.x, fy: v.y, tx: m.to.col, ty: m.to.row });
        }
      } else {
        this.handleMisc(e, 0);
      }
    }
    this.sound.playShuffle();
    const rows = this.state.level.rows;
    const cols = this.state.level.cols;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const swirl = this.reducedMotion ? 0.25 : 1.3;
    const L = this.renderer.getLayout();
    this.particles.sparkle(L.originX + L.boardW / 2, L.originY + L.boardH / 2, 18, GOLD, L.boardW * 0.35, L.cellSize * 2);
    await this.tween(0.48, (p) => {
      const e = easeInOutCubic(p);
      const ang = Math.sin(Math.PI * p) * swirl;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const pull = 1 - Math.sin(Math.PI * p) * 0.35;
      for (const m of maps) {
        const lx = m.fx + (m.tx - m.fx) * e - cx;
        const ly = m.fy + (m.ty - m.fy) * e - cy;
        m.v.x = cx + (lx * ca - ly * sa) * pull;
        m.v.y = cy + (lx * sa + ly * ca) * pull;
        m.v.rotation = this.reducedMotion ? 0 : e * Math.PI * 2;
        m.v.pop = 1 - Math.sin(Math.PI * p) * 0.22;
      }
    });
    for (const m of maps) {
      m.v.x = m.tx;
      m.v.y = m.ty;
      m.v.rotation = 0;
      m.v.velRotation = 0;
      m.v.pop = 1;
      m.v.velScaleY -= 3 * this.motionK();
      m.v.velScaleX += 2.5 * this.motionK();
    }
  }

  /* ------------------------------- intro ------------------------------- */

  private playIntro(): void {
    const gen = this.generation;
    const rows = this.state.level.rows;
    const k = this.motionK();
    this.busy++;
    this.emit();
    let maxEnd = 0;
    for (const v of this.visuals.values()) {
      const row = v.y;
      const col = v.x;
      if (this.reducedMotion) {
        v.pop = 0.2;
        v.alpha = 0;
        v.velPop = 0;
        const delay = (row + col) * 0.012;
        maxEnd = Math.max(maxEnd, delay + 0.2);
        const target = v;
        this.schedule(delay, () => {
          target.velPop = 5;
        });
        continue;
      }
      const sy = row - rows - 1;
      v.y = sy;
      const delay = col * 0.028 + (rows - 1 - row) * 0.02;
      const dur = 0.42;
      maxEnd = Math.max(maxEnd, delay + dur);
      const target = v;
      void this.tween(
        dur,
        (p) => {
          target.y = sy + (row - sy) * easeInQuad(p);
        },
        delay,
        () => {
          target.y = row;
          target.velScaleY -= 6 * k;
          target.velScaleX += 5 * k;
          if (this.time - this.lastLandSound > 0.09) {
            this.lastLandSound = this.time;
            this.sound.playLand(0.5);
          }
        },
      );
    }
    void this.wait(maxEnd + 0.08).then(() => {
      if (gen !== this.generation) return;
      this.busy = Math.max(0, this.busy - 1);
      this.emit();
      this.drainBufferedSwap();
    });
  }

  /* ===================================================================== */
  /* Hint                                                                   */
  /* ===================================================================== */

  private updateHint(dt: number): void {
    const canHint = this.busy === 0 && !this.ended && this.state.status === 'playing' && !this.pointer && !this.activeBooster && !this.selected;
    this.idle = canHint ? this.idle + dt : 0;
    let target = 0;
    if (this.idle > HINT_DELAY) {
      if (this.hintMove === undefined) {
        try {
          const moves = findValidMoves(this.state.grid);
          this.hintMove = moves.length ? moves.reduce((best, m) => (m.priority > best.priority ? m : best), moves[0]) : null;
        } catch {
          this.hintMove = null;
        }
      }
      if (this.hintMove) target = 1;
    }
    this.hintStrength += (target - this.hintStrength) * Math.min(1, dt * 6);

    const move = this.hintMove;
    const a = move ? this.visualAt(move.from) : undefined;
    const b = move ? this.visualAt(move.to) : undefined;
    const ids: [number, number] | null = a && b ? [a.id, b.id] : null;
    if (this.hintIds && (!ids || ids[0] !== this.hintIds[0] || ids[1] !== this.hintIds[1])) {
      for (const id of this.hintIds) {
        const v = this.visuals.get(id);
        if (v) {
          v.offsetX = 0;
          v.offsetY = 0;
        }
      }
    }
    this.hintIds = ids;
    if (!move || !a || !b) return;
    const amp = (this.reducedMotion ? 0.04 : 0.11) * this.hintStrength;
    const wave = 0.5 - 0.5 * Math.cos((this.time * Math.PI * 2) / 1.3);
    const lean = amp * wave;
    const dx = move.to.col - move.from.col;
    const dy = move.to.row - move.from.row;
    a.offsetX = dx * lean;
    a.offsetY = dy * lean;
    b.offsetX = -dx * lean;
    b.offsetY = -dy * lean;
    if (this.hintStrength > 0.5) {
      this.hintSparkle -= dt;
      if (this.hintSparkle <= 0) {
        this.hintSparkle = 0.65;
        const c = this.renderer.cellCenter((move.from.row + move.to.row) / 2, (move.from.col + move.to.col) / 2);
        this.particles.sparkle(c.x, c.y, 3, GOLD, this.renderer.cellSize * 0.35, this.renderer.cellSize * 0.6);
      }
    }
  }

  private resetIdle(): void {
    this.idle = 0;
  }

  /* ===================================================================== */
  /* Input                                                                  */
  /* ===================================================================== */

  private preventDefault = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  private onWindowResize = (): void => this.resize();

  private canInteract(): boolean {
    return this.running && !this.destroyed && this.busy === 0 && !this.ended && this.state.status === 'playing';
  }

  /** True while the board is still settling but an early swipe may be buffered for it. */
  private canBufferInput(): boolean {
    return (
      this.running &&
      !this.destroyed &&
      this.busy > 0 &&
      !this.ended &&
      this.state.status === 'playing' &&
      this.activeBooster === null
    );
  }

  /** Swaps now if the board is ready, else holds the swipe in the one-slot buffer. */
  private requestSwap(from: GridPos, to: GridPos): void {
    if (this.canInteract()) {
      this.bufferedSwap = null;
      this.attemptSwap(from, to);
      return;
    }
    if (!this.canBufferInput() || !this.cellAt(from)?.playable || !this.cellAt(to)?.playable) return;
    this.bufferedSwap = { from: { ...from }, to: { ...to }, expiresAt: nowMs() + SWIPE_BUFFER_MS };
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private cellAt(pos: GridPos | null): Cell | undefined {
    if (!pos) return undefined;
    return this.state.grid[pos.row]?.[pos.col];
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.cancelable) e.preventDefault();
    if (!this.unlocked) {
      this.unlocked = true;
      try {
        this.sound.unlock();
      } catch {
        /* audio unlock is best-effort */
      }
    }
    if (this.pointer && this.pointer.id !== e.pointerId) return;
    if (!e.isPrimary && this.pointer) return;
    this.resetIdle();
    const pt = this.localPoint(e);
    const pos = this.renderer.pointToCell(pt.x, pt.y);
    const cell = this.cellAt(pos);
    this.setHover(pos && cell?.playable ? pos : null);
    if (!this.canInteract()) {
      // Tap anywhere on the board during the Sugar Snap finale to skip straight to Victory + Next Level.
      if (this.displayStatus === 'sugar-crush' && this.sugarCrushResolved) {
        this.skipSugarCrush();
        return;
      }
      // Board still settling: track the drag so a fast swipe is buffered, not dropped.
      if (pos && cell?.playable && this.canBufferInput()) {
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          /* capture unsupported */
        }
        this.pointer = { id: e.pointerId, startX: pt.x, startY: pt.y, cell: pos, wasSelected: false, swiped: false, pendingTapSwap: null, buffered: true };
      }
      return;
    }
    if (!pos || !cell || !cell.playable) {
      this.deselect();
      return;
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }

    if (this.activeBooster === 'hammer') {
      this.useHammer(pos);
      return;
    }

    const pendingTapSwap =
      this.selected && !samePos(this.selected, pos) && isAdjacent(this.selected, pos) ? { ...this.selected } : null;

    const wasSelected = samePos(this.selected, pos);
    if (cell.candy && !cell.locked) {
      if (!wasSelected && !pendingTapSwap) this.select(pos);
    } else {
      if (cell.candy && cell.locked) this.wobble(pos);
      this.deselect();
      return;
    }
    this.pointer = { id: e.pointerId, startX: pt.x, startY: pt.y, cell: pos, wasSelected, swiped: false, pendingTapSwap, buffered: false };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const pt = this.localPoint(e);
    if (!this.pointer) {
      if (e.pointerType !== 'touch') {
        const pos = this.renderer.pointToCell(pt.x, pt.y);
        const cell = this.cellAt(pos);
        this.setHover(pos && cell?.playable ? pos : null);
      }
      return;
    }
    if (e.pointerId !== this.pointer.id) return;
    if (e.cancelable) e.preventDefault();
    const p = this.pointer;
    if (p.swiped) return;
    const dx = pt.x - p.startX;
    const dy = pt.y - p.startY;
    const threshold = SWIPE_THRESHOLD * this.renderer.cellSize;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    p.swiped = true;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const to: GridPos = horizontal ? { row: p.cell.row, col: p.cell.col + Math.sign(dx) } : { row: p.cell.row + Math.sign(dy), col: p.cell.col };
    this.deselect();
    this.requestSwap(p.cell, to);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointer || e.pointerId !== this.pointer.id) return;
    if (e.cancelable) e.preventDefault();
    const p = this.pointer;
    this.pointer = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!p.swiped && !p.buffered) {
      if (p.pendingTapSwap) {
        this.deselect();
        if (this.canInteract()) this.attemptSwap(p.pendingTapSwap, p.cell);
      } else if (p.wasSelected) {
        this.deselect();
      }
    }
    if (e.pointerType === 'touch') this.setHover(null);
    this.resetIdle();
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.pointer && e.pointerId === this.pointer.id) this.pointer = null;
    this.setHover(null);
  };

  private onPointerLeave = (e: PointerEvent): void => {
    if (!this.pointer && e.pointerType !== 'touch') this.setHover(null);
  };

  private setHover(pos: GridPos | null): void {
    if (samePos(this.hover, pos)) return;
    this.hover = pos;
    if (this.hoverId !== null) {
      const prev = this.visuals.get(this.hoverId);
      if (prev && !samePos(this.selected, { row: Math.round(prev.y), col: Math.round(prev.x) })) prev.liftTarget = 0;
      this.hoverId = null;
    }
    if (!pos || this.busy > 0) return;
    const v = this.visualAt(pos);
    if (v && !samePos(this.selected, pos)) {
      v.liftTarget = 0.35;
      this.hoverId = v.id;
    }
  }

  private select(pos: GridPos): void {
    this.deselect();
    this.selected = pos;
    const v = this.visualAt(pos);
    if (v) {
      v.liftTarget = 1;
      v.velScaleY += 3 * this.motionK();
      v.velScaleX -= 1.5 * this.motionK();
    }
    this.sound.playSelect();
  }

  private deselect(): void {
    if (!this.selected) return;
    const v = this.visualAt(this.selected);
    if (v) v.liftTarget = this.hoverId === v.id ? 0.35 : 0;
    this.selected = null;
  }

  private wobble(pos: GridPos): void {
    const v = this.visualAt(pos);
    if (v) {
      v.velRotation += 9 * this.motionK();
      v.velScaleX += 3 * this.motionK();
    }
    this.sound.playInvalidSwap();
  }

  private attemptSwap(from: GridPos, to: GridPos): void {
    const a = this.cellAt(from);
    const b = this.cellAt(to);
    if (!a || !b || !a.playable || !b.playable || !a.candy || !b.candy || a.locked || b.locked) {
      this.wobble(from);
      return;
    }
    const free = this.activeBooster === 'free-switch';
    let result: StepResult;
    try {
      result = executeSwap(this.state, from, to, free ? { freeSwitch: true } : undefined);
    } catch (err) {
      console.error('[GameController] swap failed', err);
      return;
    }
    if (free && result.valid) {
      this.activeBooster = null;
      this.sound.playBooster();
      this.opts.onBoosterConsumed('free-switch');
    }
    void this.runResult(result, { from, to });
  }

  private useHammer(pos: GridPos): void {
    const cell = this.cellAt(pos);
    if (!cell || !cell.playable || !(cell.candy || cell.frosting > 0 || cell.chocolate || cell.locked)) {
      this.wobble(pos);
      return;
    }
    let result: StepResult;
    try {
      result = applyHammerBooster(this.state, pos);
    } catch (err) {
      console.error('[GameController] hammer failed', err);
      return;
    }
    if (!result.valid) {
      this.wobble(pos);
      return;
    }
    this.activeBooster = null;
    this.bufferedSwap = null;
    this.opts.onBoosterConsumed('hammer');
    const hasFx = result.phases.some((ph) => ph.events.some((e) => e.type === 'booster-hammer'));
    if (!hasFx) {
      const c = this.renderer.cellCenter(pos.row, pos.col);
      const cs = this.renderer.cellSize;
      this.sound.playBooster();
      this.particles.shake(10 * this.motionK());
      this.particles.flash(0.16, '#fff1d0');
      this.particles.shockwave(c.x, c.y, cs * 1.5, GOLD, 12, 0.45);
      this.particles.sparkle(c.x, c.y, 12, GOLD, cs * 0.5, cs * 2);
    }
    void this.runResult(result);
  }

  /* ===================================================================== */
  /* Snapshot                                                               */
  /* ===================================================================== */

  private emit(): void {
    if (this.destroyed) return;
    const stars = calculateStars(this.displayScore, this.state.level.starThresholds);
    try {
      this.opts.onStateChange({
        score: this.displayScore,
        movesLeft: this.displayMoves,
        objectives: this.displayObjectives,
        status: this.displayStatus,
        stars,
        activeBooster: this.activeBooster,
        isAnimating: this.busy > 0,
      });
    } catch (err) {
      console.error('[GameController] onStateChange threw', err);
    }
  }
}
