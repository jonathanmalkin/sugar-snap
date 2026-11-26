import { ALL_CANDY_COLORS } from './types';
import type {
  AnimationEvent,
  Candy,
  CandyColor,
  Cell,
  GameState,
  GridPos,
  MatchGroup,
  PhaseKind,
  PraiseWord,
  ResolutionPhase,
  SpecialType,
  StepResult,
} from './types';
import {
  calculateStars,
  candyMatchesOrder,
  canHoldCandy,
  cloneGrid,
  cloneState,
  computeObjectivesProgress,
  findCandyPosition,
  findValidMoves,
  getCell,
  isSwappableCell,
  pickColor,
  posKey,
  shuffleBoard,
  type Rng,
} from './board';
import { findMatches, formsMatchAt } from './matcher';

export const SCORE_VALUES = {
  line3: 60,
  line4: 120,
  line5: 200,
  lt: 200,
  blastCandy: 60,
  jellyLayer: 1000,
  blockerHit: 20,
  ingredient: 10000,
  comet: 1500,
} as const;

/** Callout words by cascade depth for Sugar Snap. */
const PRAISE_TIERS: ReadonlyArray<{ minCascade: number; word: PraiseWord }> = [
  { minCascade: 2, word: 'Snappy!' },
  { minCascade: 3, word: 'Juicy!' },
  { minCascade: 4, word: 'Yummy!' },
  { minCascade: 5, word: 'Spectacular!' },
];

export function praiseForCascade(cascade: number): PraiseWord | null {
  let word: PraiseWord | null = null;
  for (const tier of PRAISE_TIERS) if (cascade >= tier.minCascade) word = tier.word;
  return word;
}

// ---------------------------------------------------------------------------
// Swap rules

export function isAdjacent(a: GridPos, b: GridPos): boolean {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
}

function isSpecial(c: Candy | null | undefined): c is Candy {
  return !!c && !c.ingredient && c.special !== 'none';
}

const isStriped = (s: SpecialType) => s === 'striped-h' || s === 'striped-v';

/** Two specials, or a colour bomb with any non-ingredient candy. */
export function isSpecialComboPair(a: Candy | null | undefined, b: Candy | null | undefined): boolean {
  if (!a || !b || a.ingredient || b.ingredient) return false;
  if (isSpecial(a) && isSpecial(b)) return true;
  return a.special === 'color-bomb' || b.special === 'color-bomb';
}

export function canSwap(grid: Cell[][], from: GridPos, to: GridPos): boolean {
  if (!isAdjacent(from, to)) return false;
  const a = getCell(grid, from);
  const b = getCell(grid, to);
  if (!isSwappableCell(a) || !isSwappableCell(b)) return false;
  const ca = a.candy!;
  const cb = b.candy!;
  if (isSpecialComboPair(ca, cb)) return true;
  a.candy = cb;
  b.candy = ca;
  try {
    return formsMatchAt(grid, from) || formsMatchAt(grid, to);
  } finally {
    a.candy = ca;
    b.candy = cb;
  }
}

// ---------------------------------------------------------------------------
// Resolution context (shared with sugarCrush.ts)

export interface ResolveContext {
  s: GameState;
  rng: Rng;
  phases: ResolutionPhase[];
  /** Wrapped candies waiting for their second explosion, by candy id → radius. */
  pending: Map<number, 1 | 2>;
  maxCascade: number;
}

export function createResolveContext(state: GameState, rng: Rng): ResolveContext {
  return { s: cloneState(state), rng, phases: [], pending: new Map(), maxCascade: 0 };
}

function refreshObjectives(s: GameState): void {
  s.objectives = computeObjectivesProgress(s.level, s.grid, s.score, s.collectedOrders, s.collectedIngredients);
}

export function pushPhase(ctx: ResolveContext, kind: PhaseKind, events: AnimationEvent[]): void {
  refreshObjectives(ctx.s);
  ctx.phases.push({
    kind,
    events,
    gridAfter: cloneGrid(ctx.s.grid),
    scoreAfter: ctx.s.score,
    objectivesAfter: ctx.s.objectives.map((o) => ({ ...o })),
  });
}

export interface Wave {
  events: AnimationEvent[];
  hit: Set<string>;
  blockerHit: Set<string>;
  activated: Set<number>;
  queue: Array<{ pos: GridPos; candy: Candy }>;
}

export function createWave(events: AnimationEvent[]): Wave {
  return { events, hit: new Set(), blockerHit: new Set(), activated: new Set(), queue: [] };
}

function newCandy(ctx: ResolveContext, color: CandyColor | 'none', special: SpecialType): Candy {
  return { id: ctx.s.nextCandyId++, color, special };
}

function recordCleared(ctx: ResolveContext, candy: Candy): void {
  for (const obj of ctx.s.level.objectives)
    if (candyMatchesOrder(obj, candy)) ctx.s.collectedOrders[obj.id] = (ctx.s.collectedOrders[obj.id] ?? 0) + 1;
}

function reduceJelly(ctx: ResolveContext, wave: Wave, cell: Cell): void {
  if (cell.jelly <= 0) return;
  cell.jelly = (cell.jelly - 1) as 0 | 1;
  ctx.s.score += SCORE_VALUES.jellyLayer;
  wave.events.push({ type: 'jelly-clear', pos: { row: cell.row, col: cell.col }, remaining: cell.jelly as 0 | 1 });
}

function hitBlocker(ctx: ResolveContext, wave: Wave, cell: Cell): void {
  const k = posKey(cell);
  if (wave.blockerHit.has(k)) return;
  const pos = { row: cell.row, col: cell.col };
  if (cell.frosting > 0) {
    wave.blockerHit.add(k);
    cell.frosting = (cell.frosting - 1) as 0 | 1 | 2;
    ctx.s.score += SCORE_VALUES.blockerHit;
    wave.events.push({ type: 'blocker-hit', pos, blocker: 'frosting', remaining: cell.frosting });
  } else if (cell.chocolate) {
    wave.blockerHit.add(k);
    cell.chocolate = false;
    ctx.s.chocolateClearedThisTurn = true;
    ctx.s.score += SCORE_VALUES.blockerHit;
    wave.events.push({ type: 'blocker-hit', pos, blocker: 'chocolate', remaining: 0 });
  }
}

/**
 * Apply one hit to a cell.
 *  match — the candy was part of a match (frosting/chocolate are hit by adjacency instead)
 *  blast — a special, booster or combo hit the cell directly
 *  wipe  — the double colour bomb: clears without triggering specials
 */
export function damageCell(ctx: ResolveContext, wave: Wave, pos: GridPos, source: 'match' | 'blast' | 'wipe'): void {
  const cell = getCell(ctx.s.grid, pos);
  if (!cell || !cell.playable) return;
  if (cell.frosting > 0 || cell.chocolate) {
    if (source !== 'match') hitBlocker(ctx, wave, cell);
    return;
  }
  const k = posKey(pos);
  if (wave.hit.has(k)) return;
  wave.hit.add(k);
  const candy = cell.candy;
  if (!candy) {
    if (source !== 'match') reduceJelly(ctx, wave, cell);
    return;
  }
  if (cell.locked) {
    if (!wave.blockerHit.has(k)) {
      wave.blockerHit.add(k);
      cell.locked = false;
      wave.events.push({ type: 'blocker-hit', pos: { ...pos }, blocker: 'lock', remaining: 0 });
    }
    return;
  }
  if (candy.ingredient) return;
  if (source !== 'match') ctx.s.score += SCORE_VALUES.blastCandy;
  recordCleared(ctx, candy);
  reduceJelly(ctx, wave, cell);
  if (source !== 'wipe' && isSpecial(candy) && !wave.activated.has(candy.id) && !ctx.pending.has(candy.id)) {
    wave.activated.add(candy.id);
    wave.queue.push({ pos: { ...pos }, candy });
    if (candy.special === 'wrapped') {
      // Stage one: the wrapped candy stays on the board, falls, then explodes again.
      ctx.pending.set(candy.id, 1);
      return;
    }
  }
  cell.candy = null;
}

function lineCells(grid: Cell[][], orientation: 'h' | 'v', index: number): GridPos[] {
  const out: GridPos[] = [];
  if (orientation === 'h') grid[index]?.forEach((cell) => cell.playable && out.push({ row: cell.row, col: cell.col }));
  else for (const row of grid) if (row[index]?.playable) out.push({ row: row[index].row, col: index });
  return out;
}

function squareCells(grid: Cell[][], center: GridPos, radius: number): GridPos[] {
  const out: GridPos[] = [];
  for (let r = center.row - radius; r <= center.row + radius; r++)
    for (let c = center.col - radius; c <= center.col + radius; c++)
      if (grid[r]?.[c]?.playable) out.push({ row: r, col: c });
  return out;
}

function cellsOfColor(grid: Cell[][], color: CandyColor): GridPos[] {
  const out: GridPos[] = [];
  for (const row of grid)
    for (const cell of row)
      if (canHoldCandy(cell) && cell.candy && !cell.candy.ingredient && cell.candy.color === color)
        out.push({ row: cell.row, col: cell.col });
  return out;
}

/** A colour bomb hit by a blast zaps the most common colour on the board. */
function pickBombColor(grid: Cell[][]): CandyColor | null {
  const counts = new Map<CandyColor, number>();
  for (const row of grid)
    for (const cell of row) {
      const c = cell.candy;
      if (canHoldCandy(cell) && c && !c.ingredient && c.color !== 'none') counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
    }
  let best: CandyColor | null = null;
  for (const color of ALL_CANDY_COLORS) if ((counts.get(color) ?? 0) > (best ? counts.get(best)! : 0)) best = color;
  return best;
}

function fireSpecial(ctx: ResolveContext, wave: Wave, pos: GridPos, candy: Candy): void {
  const grid = ctx.s.grid;
  switch (candy.special) {
    case 'striped-h':
    case 'striped-v': {
      const orientation = candy.special === 'striped-h' ? 'h' : 'v';
      const affected = lineCells(grid, orientation, orientation === 'h' ? pos.row : pos.col);
      wave.events.push({ type: 'laser', origin: { ...pos }, orientation, color: candy.color, affected, width: 1 });
      affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
      break;
    }
    case 'wrapped': {
      const affected = squareCells(grid, pos, 1).filter((p) => p.row !== pos.row || p.col !== pos.col);
      wave.events.push({ type: 'wrapped-boom', center: { ...pos }, radius: 1, stage: 1, color: candy.color, affected });
      affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
      break;
    }
    case 'color-bomb': {
      const color = pickBombColor(grid);
      const targets = color ? cellsOfColor(grid, color) : [];
      wave.events.push({ type: 'lightning', origin: { ...pos }, targets, color: color ?? 'none' });
      targets.forEach((p) => damageCell(ctx, wave, p, 'blast'));
      break;
    }
    case 'none':
      break;
  }
}

/** Fire every queued special, breadth first. Cycle-safe: each candy fires once per wave. */
export function runActivationQueue(ctx: ResolveContext, wave: Wave): void {
  for (let guard = 0; wave.queue.length && guard < 10000; guard++) {
    const { pos, candy } = wave.queue.shift()!;
    fireSpecial(ctx, wave, pos, candy);
  }
}

// ---------------------------------------------------------------------------
// Matches, combos, gravity

const ORTHO = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function processMatchStep(ctx: ResolveContext, groups: MatchGroup[], cascade: number): void {
  const events: AnimationEvent[] = [];
  const wave = createWave(events);
  const grid = ctx.s.grid;
  for (const g of groups) {
    const points = SCORE_VALUES[g.shape] * cascade;
    ctx.s.score += points;
    events.push({ type: 'match', cells: g.cells.map((p) => ({ ...p })), color: g.color, cascade, points });
    events.push({ type: 'score-popup', pos: { ...g.spawnPos }, points, color: g.color });
  }
  for (const g of groups) for (const p of g.cells) damageCell(ctx, wave, p, 'match');
  for (const g of groups)
    for (const p of g.cells)
      for (const [dr, dc] of ORTHO) {
        const n = getCell(grid, { row: p.row + dr, col: p.col + dc });
        if (n && n.playable && (n.frosting > 0 || n.chocolate)) hitBlocker(ctx, wave, n);
      }
  runActivationQueue(ctx, wave);
  for (const g of groups) {
    if (g.spawnSpecial === 'none') continue;
    const target = [g.spawnPos, ...g.cells].map((p) => getCell(grid, p)!).find((c) => canHoldCandy(c) && !c.candy);
    if (!target) continue;
    const candy = newCandy(ctx, g.spawnSpecial === 'color-bomb' ? 'none' : g.color, g.spawnSpecial);
    target.candy = candy;
    events.push({ type: 'special-spawn', pos: { row: target.row, col: target.col }, candy: { ...candy } });
  }
  const word = praiseForCascade(cascade);
  if (word) events.push({ type: 'callout', text: word, pos: { ...groups[0].spawnPos }, cascade });
  ctx.maxCascade = Math.max(ctx.maxCascade, cascade);
  pushPhase(ctx, 'clear', events);
}

function executeCombo(ctx: ResolveContext, from: GridPos, to: GridPos): void {
  const grid = ctx.s.grid;
  const toCell = getCell(grid, to)!;
  const fromCell = getCell(grid, from)!;
  const a = toCell.candy!; // the candy the player dragged
  const b = fromCell.candy!;
  const events: AnimationEvent[] = [];
  const wave = createWave(events);
  for (const [cell, candy] of [
    [fromCell, b],
    [toCell, a],
  ] as const) {
    wave.hit.add(posKey(cell));
    wave.activated.add(candy.id);
    recordCleared(ctx, candy);
    cell.candy = null;
    reduceJelly(ctx, wave, cell);
  }
  const bombA = a.special === 'color-bomb';
  const bombB = b.special === 'color-bomb';

  if (bombA && bombB) {
    const affected: GridPos[] = [];
    for (const row of grid) for (const cell of row) if (cell.playable) affected.push({ row: cell.row, col: cell.col });
    events.push({ type: 'board-wipe', origin: { ...to }, affected });
    for (const p of affected) {
      const cell = getCell(grid, p)!;
      const k = posKey(p);
      if (wave.hit.has(k)) continue; // the two bombs' own cells already lost a jelly layer
      if (cell.frosting > 0 || cell.chocolate) {
        hitBlocker(ctx, wave, cell);
        if (cell.jelly > 0) reduceJelly(ctx, wave, cell);
        continue;
      }
      damageCell(ctx, wave, p, 'wipe');
    }
    const word = praiseForCascade(Number.MAX_SAFE_INTEGER);
    if (word) events.push({ type: 'callout', text: word, pos: { ...to }, cascade: 1 });
  } else if (bombA || bombB) {
    const bombPos = bombA ? to : from;
    const other = bombA ? b : a;
    const color = other.color as CandyColor;
    if (other.special === 'none') {
      const targets = cellsOfColor(grid, color);
      events.push({ type: 'lightning', origin: { ...bombPos }, targets, color });
      targets.forEach((p) => damageCell(ctx, wave, p, 'blast'));
    } else {
      const convertTo = isStriped(other.special) ? 'striped' : 'wrapped';
      const targets = cellsOfColor(grid, color).filter((p) => {
        const cell = getCell(grid, p)!;
        return !cell.locked && cell.candy!.special === 'none';
      });
      for (const p of targets) {
        const candy = getCell(grid, p)!.candy!;
        candy.special = convertTo === 'wrapped' ? 'wrapped' : ctx.rng() < 0.5 ? 'striped-h' : 'striped-v';
      }
      events.push({ type: 'lightning', origin: { ...bombPos }, targets, color, convertTo });
      pushPhase(ctx, 'combo', events);
      // Detonate every candy of that colour (converted ones and specials already there).
      const detonation: AnimationEvent[] = [];
      const wave2 = createWave(detonation);
      cellsOfColor(grid, color).forEach((p) => damageCell(ctx, wave2, p, 'blast'));
      runActivationQueue(ctx, wave2);
      pushPhase(ctx, 'combo', detonation);
      return;
    }
  } else if (isStriped(a.special) && isStriped(b.special)) {
    for (const orientation of ['h', 'v'] as const) {
      const affected = lineCells(grid, orientation, orientation === 'h' ? to.row : to.col);
      events.push({ type: 'laser', origin: { ...to }, orientation, color: a.color, affected, width: 1 });
      affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
    }
  } else if (isStriped(a.special) || isStriped(b.special)) {
    for (const orientation of ['h', 'v'] as const) {
      const centre = orientation === 'h' ? to.row : to.col;
      const affected = [centre - 1, centre, centre + 1].flatMap((i) => lineCells(grid, orientation, i));
      events.push({ type: 'laser', origin: { ...to }, orientation, color: a.color, affected, width: 3 });
      affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
    }
  } else {
    // Wrapped + wrapped: 5x5 now, then 5x5 again where the marker settles.
    toCell.candy = a;
    ctx.pending.set(a.id, 2);
    const affected = squareCells(grid, to, 2).filter((p) => p.row !== to.row || p.col !== to.col);
    events.push({ type: 'wrapped-boom', center: { ...to }, radius: 2, stage: 1, color: a.color, affected });
    affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
  }
  runActivationQueue(ctx, wave);
  pushPhase(ctx, 'combo', events);
}

function fireSecondStages(ctx: ResolveContext): void {
  const grid = ctx.s.grid;
  const events: AnimationEvent[] = [];
  const wave = createWave(events);
  const items: Array<{ pos: GridPos; radius: 1 | 2; candy: Candy }> = [];
  for (const [id, radius] of ctx.pending) {
    const pos = findCandyPosition(grid, id);
    if (pos) items.push({ pos, radius, candy: getCell(grid, pos)!.candy! });
  }
  ctx.pending.clear();
  for (const { pos, candy } of items) {
    const cell = getCell(grid, pos)!;
    cell.candy = null;
    cell.locked = false;
    wave.hit.add(posKey(pos));
    wave.activated.add(candy.id);
    reduceJelly(ctx, wave, cell);
  }
  for (const { pos, radius, candy } of items) {
    const affected = squareCells(grid, pos, radius);
    events.push({ type: 'wrapped-boom', center: { ...pos }, radius, stage: 2, color: candy.color, affected });
    affected.forEach((p) => damageCell(ctx, wave, p, 'blast'));
  }
  runActivationQueue(ctx, wave);
  pushPhase(ctx, 'wrapped-second', events);
}

interface GravityMove {
  candyId: number;
  from: GridPos;
  to: GridPos;
  isNew: boolean;
  candy: Candy;
}

function spawnCandy(ctx: ResolveContext, col: number, cell: Cell): Candy {
  const s = ctx.s;
  if (!cell.isExit && s.ingredientsRemainingToSpawn.length) {
    for (const rule of s.level.ingredientSpawns ?? []) {
      if (!rule.spawnCols.includes(col)) continue;
      const idx = s.ingredientsRemainingToSpawn.indexOf(rule.type);
      if (idx < 0) continue;
      let onBoard = 0;
      for (const row of s.grid) for (const c of row) if (c.candy?.ingredient === rule.type) onBoard++;
      if (onBoard >= rule.maxOnBoard) continue;
      s.ingredientsRemainingToSpawn.splice(idx, 1);
      return { id: s.nextCandyId++, color: 'none', special: 'none', ingredient: rule.type };
    }
  }
  return newCandy(ctx, pickColor(s.level.colors, ctx.rng), 'none');
}

/**
 * Settle the board: candies fall straight down (passing through holes), new candies
 * enter at each column's top playable cell, and candies slide diagonally into cells
 * shadowed by frosting, chocolate or locks so no reachable pocket stays empty.
 */
function applyGravity(ctx: ResolveContext): GravityMove[] {
  const grid = ctx.s.grid;
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const moves = new Map<number, GravityMove>();
  const spawned = new Array<number>(cols).fill(0);
  const isEmpty = (cell: Cell | undefined): cell is Cell => canHoldCandy(cell) && !cell.candy;
  const isMovable = (cell: Cell | undefined): cell is Cell => canHoldCandy(cell) && !!cell.candy && !cell.locked;
  const relocate = (from: Cell, to: Cell) => {
    const candy = from.candy!;
    from.candy = null;
    to.candy = candy;
    const rec = moves.get(candy.id);
    if (rec) rec.to = { row: to.row, col: to.col };
    else moves.set(candy.id, { candyId: candy.id, from: { row: from.row, col: from.col }, to: { row: to.row, col: to.col }, isNew: false, candy });
  };

  for (let guard = 0; guard < rows * cols * 50 + 10; guard++) {
    let changed = false;
    for (let r = rows - 1; r >= 0; r--)
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!isEmpty(cell)) continue;
        let rr = r - 1;
        while (rr >= 0 && !grid[rr][c].playable) rr--;
        if (rr < 0) {
          const candy = spawnCandy(ctx, c, cell);
          cell.candy = candy;
          spawned[c]++;
          moves.set(candy.id, { candyId: candy.id, from: { row: r - spawned[c], col: c }, to: { row: r, col: c }, isNew: true, candy });
          changed = true;
        } else if (isMovable(grid[rr][c])) {
          relocate(grid[rr][c], cell);
          changed = true;
        }
      }
    if (changed) continue;
    let slid = false;
    outer: for (let r = rows - 1; r >= 1; r--)
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!isEmpty(cell)) continue;
        for (const dc of [-1, 1]) {
          const src = grid[r - 1][c + dc];
          if (isMovable(src)) {
            relocate(src, cell);
            slid = true;
            break outer;
          }
        }
      }
    if (!slid) break;
  }
  return [...moves.values()].map((m) => ({ ...m, candy: { ...m.candy } }));
}

function collectIngredients(ctx: ResolveContext): boolean {
  const events: AnimationEvent[] = [];
  for (const row of ctx.s.grid)
    for (const cell of row) {
      const candy = cell.candy;
      if (!cell.isExit || !candy?.ingredient) continue;
      ctx.s.collectedIngredients[candy.ingredient] = (ctx.s.collectedIngredients[candy.ingredient] ?? 0) + 1;
      ctx.s.score += SCORE_VALUES.ingredient;
      events.push({ type: 'ingredient-collect', pos: { row: cell.row, col: cell.col }, ingredient: candy.ingredient, candyId: candy.id });
      cell.candy = null;
    }
  if (events.length) pushPhase(ctx, 'clear', events);
  return events.length > 0;
}

/** Gravity → exits → wrapped second stages → cascades, until nothing changes. Returns the last cascade number. */
export function settleBoard(ctx: ResolveContext, startCascade: number): number {
  let cascade = startCascade;
  for (let guard = 0; guard < 1000; guard++) {
    const moves = applyGravity(ctx);
    if (moves.length) pushPhase(ctx, 'gravity', [{ type: 'gravity', moves }]);
    if (collectIngredients(ctx)) continue;
    if (ctx.pending.size) {
      fireSecondStages(ctx);
      continue;
    }
    const groups = findMatches(ctx.s.grid);
    if (!groups.length) break;
    cascade++;
    processMatchStep(ctx, groups, cascade);
  }
  return cascade;
}

function spreadChocolate(ctx: ResolveContext): void {
  const s = ctx.s;
  if (s.chocolateClearedThisTurn) return;
  const options: Array<{ from: GridPos; to: GridPos }> = [];
  for (const row of s.grid)
    for (const cell of row) {
      if (!cell.playable || !cell.chocolate) continue;
      for (const [dr, dc] of ORTHO) {
        const n = getCell(s.grid, { row: cell.row + dr, col: cell.col + dc });
        if (!n || !canHoldCandy(n) || n.locked || !n.candy || n.candy.special !== 'none' || n.candy.ingredient) continue;
        options.push({ from: { row: cell.row, col: cell.col }, to: { row: n.row, col: n.col } });
      }
    }
  if (!options.length) return;
  const pick = options[Math.min(options.length - 1, Math.floor(ctx.rng() * options.length))];
  const target = getCell(s.grid, pick.to)!;
  target.candy = null;
  target.chocolate = true;
  pushPhase(ctx, 'chocolate', [{ type: 'chocolate-spread', from: pick.from, to: pick.to }]);
}

/** Objectives, win/lose and deadlock handling at the end of a player action. */
export function finishTurn(ctx: ResolveContext): StepResult {
  const s = ctx.s;
  refreshObjectives(s);
  s.maxCascade = Math.max(s.maxCascade, ctx.maxCascade);
  let didShuffle = false;
  const allDone = s.objectives.length > 0 && s.objectives.every((o) => o.completed);
  if (allDone) s.status = s.movesLeft > 0 ? 'sugar-crush' : 'won';
  else if (s.movesLeft <= 0) s.status = 'lost';
  else if (findValidMoves(s.grid).length === 0) {
    const { grid, mappings } = shuffleBoard(s, ctx.rng);
    s.grid = grid;
    pushPhase(ctx, 'shuffle', [{ type: 'shuffle', mappings }]);
    didShuffle = true;
  }
  return { valid: true, state: s, phases: ctx.phases, starsEarned: calculateStars(s.score, s.level.starThresholds), didShuffle };
}

function invalidResult(state: GameState, phases: ResolutionPhase[] = []): StepResult {
  return { valid: false, state, phases, starsEarned: calculateStars(state.score, state.level.starThresholds), didShuffle: false };
}

// ---------------------------------------------------------------------------
// Player actions

export function executeSwap(
  state: GameState,
  from: GridPos,
  to: GridPos,
  opts: { freeSwitch?: boolean; rng?: () => number } = {},
): StepResult {
  const rng = opts.rng ?? Math.random;
  const free = !!opts.freeSwitch;
  const rejected = () =>
    invalidResult(state, [
      {
        kind: 'swap',
        events: [{ type: 'swap', from: { ...from }, to: { ...to }, valid: false }],
        gridAfter: cloneGrid(state.grid),
        scoreAfter: state.score,
        objectivesAfter: state.objectives.map((o) => ({ ...o })),
      },
    ]);
  if (state.status !== 'playing' || !isAdjacent(from, to)) return rejected();
  if (!isSwappableCell(getCell(state.grid, from)) || !isSwappableCell(getCell(state.grid, to))) return rejected();
  if (!free && !canSwap(state.grid, from, to)) return rejected();

  const ctx = createResolveContext(state, rng);
  const s = ctx.s;
  s.chocolateClearedThisTurn = false;
  const fromCell = getCell(s.grid, from)!;
  const toCell = getCell(s.grid, to)!;
  [fromCell.candy, toCell.candy] = [toCell.candy, fromCell.candy];
  pushPhase(ctx, 'swap', [{ type: 'swap', from: { ...from }, to: { ...to }, valid: true }]);
  if (!free) {
    s.movesLeft -= 1;
    s.totalMovesMade += 1;
  }

  if (isSpecialComboPair(toCell.candy, fromCell.candy)) {
    ctx.maxCascade = Math.max(ctx.maxCascade, 1);
    executeCombo(ctx, from, to);
    settleBoard(ctx, 1);
  } else {
    const groups = findMatches(s.grid, [from, to]);
    if (groups.length) {
      processMatchStep(ctx, groups, 1);
      settleBoard(ctx, 1);
    }
  }
  if (!free) spreadChocolate(ctx);
  return finishTurn(ctx);
}

export function applyHammerBooster(state: GameState, target: GridPos, rng: () => number = Math.random): StepResult {
  const cell = getCell(state.grid, target);
  if (state.status !== 'playing' || !cell || !cell.playable) return invalidResult(state);
  if (cell.candy?.ingredient) return invalidResult(state);
  if (!cell.candy && cell.frosting === 0 && !cell.chocolate) return invalidResult(state);
  const ctx = createResolveContext(state, rng);
  const events: AnimationEvent[] = [{ type: 'booster-hammer', pos: { ...target } }];
  const wave = createWave(events);
  damageCell(ctx, wave, target, 'blast');
  runActivationQueue(ctx, wave);
  pushPhase(ctx, 'clear', events);
  settleBoard(ctx, 0);
  return finishTurn(ctx);
}

export function applyShuffleBooster(state: GameState, rng: () => number = Math.random): StepResult {
  if (state.status !== 'playing') return invalidResult(state);
  const ctx = createResolveContext(state, rng);
  const { grid, mappings } = shuffleBoard(ctx.s, rng);
  ctx.s.grid = grid;
  pushPhase(ctx, 'shuffle', [{ type: 'shuffle', mappings }]);
  return { valid: true, state: ctx.s, phases: ctx.phases, starsEarned: calculateStars(ctx.s.score, ctx.s.level.starThresholds), didShuffle: true };
}
