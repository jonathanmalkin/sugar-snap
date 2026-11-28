import type { ZenSaveState } from '../state/storageTypes';
import { ALL_CANDY_COLORS } from './types';
import type {
  Candy,
  CandyColor,
  Cell,
  GameState,
  GridPos,
  IngredientType,
  LevelDef,
  ObjectiveProgress,
  ObjectiveTarget,
  SpecialType,
  ValidMove,
} from './types';
import { findMatches, matchableColor } from './matcher';
import { canSwap, isSpecialComboPair } from './resolver';

export type Rng = () => number;

/** Small deterministic PRNG (mulberry32) for replays, tests and seeded boards. */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function posKey(p: GridPos): string {
  return `${p.row},${p.col}`;
}

export function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map((cell) => ({ ...cell, candy: cell.candy ? { ...cell.candy } : null })));
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    grid: cloneGrid(state.grid),
    objectives: state.objectives.map((o) => ({ ...o })),
    ingredientsRemainingToSpawn: [...state.ingredientsRemainingToSpawn],
    collectedOrders: { ...state.collectedOrders },
    collectedIngredients: { ...state.collectedIngredients },
  };
}

export function getCell(grid: Cell[][], pos: GridPos): Cell | undefined {
  return grid[pos.row]?.[pos.col];
}

/** A cell that can contain a candy (playable, no frosting, no chocolate). */
export function canHoldCandy(cell: Cell | null | undefined): cell is Cell {
  return !!cell && cell.playable && cell.frosting === 0 && !cell.chocolate;
}

/** A cell whose candy may be swapped by the player. */
export function isSwappableCell(cell: Cell | null | undefined): cell is Cell {
  return canHoldCandy(cell) && !cell.locked && !!cell.candy;
}

export function isRegularCandy(candy: Candy | null | undefined): candy is Candy {
  return !!candy && !candy.ingredient && candy.special === 'none' && candy.color !== 'none';
}

export function findCandyPosition(grid: Cell[][], candyId: number): GridPos | null {
  for (const row of grid) for (const cell of row) if (cell.candy?.id === candyId) return { row: cell.row, col: cell.col };
  return null;
}

function blankCell(row: number, col: number): Cell {
  return { row, col, playable: true, jelly: 0, frosting: 0, locked: false, chocolate: false, isExit: false, candy: null };
}

function colorPool(colors: readonly CandyColor[]): readonly CandyColor[] {
  return colors.length ? colors : ALL_CANDY_COLORS;
}

export function pickColor(colors: readonly CandyColor[], rng: Rng, forbidden?: Set<CandyColor>): CandyColor {
  const pool = colorPool(colors);
  const allowed = forbidden ? pool.filter((c) => !forbidden.has(c)) : pool;
  const list = allowed.length ? allowed : pool;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/** Colours that would complete a match through (row, col). */
export function forbiddenColorsAt(grid: Cell[][], row: number, col: number): Set<CandyColor> {
  const f = new Set<CandyColor>();
  const at = (r: number, c: number) => matchableColor(grid[r]?.[c]);
  const pairs: Array<[number, number, number, number]> = [
    [0, -1, 0, -2],
    [0, 1, 0, 2],
    [0, -1, 0, 1],
    [-1, 0, -2, 0],
    [1, 0, 2, 0],
    [-1, 0, 1, 0],
  ];
  for (const [a, b, c, d] of pairs) {
    const x = at(row + a, col + b);
    if (x && x === at(row + c, col + d)) f.add(x);
  }
  for (const dr of [-1, 1])
    for (const dc of [-1, 1]) {
      const x = at(row + dr, col);
      if (x && x === at(row, col + dc) && x === at(row + dr, col + dc)) f.add(x);
    }
  return f;
}

function parseLayout(level: LevelDef): Cell[][] {
  const grid: Cell[][] = [];
  for (let r = 0; r < level.rows; r++) {
    const line = level.layout[r] ?? '';
    const row: Cell[] = [];
    for (let c = 0; c < level.cols; c++) {
      const cell = blankCell(r, c);
      switch (line[c] ?? '.') {
        case '#':
          cell.playable = false;
          break;
        case 'j':
          cell.jelly = 1;
          break;
        case 'J':
          cell.jelly = 2;
          break;
        case '1':
          cell.frosting = 1;
          break;
        case '2':
          cell.frosting = 2;
          break;
        case '3':
          cell.frosting = 3;
          break;
        case 'L':
          cell.locked = true;
          cell.lockLayers = 1;
          break;
        case 'M':
          cell.locked = true;
          cell.lockLayers = 2;
          break;
        case 'K':
          cell.locked = true;
          cell.lockLayers = 3;
          break;
        case 'C':
          cell.chocolate = true;
          break;
        case 'E':
          cell.isExit = true;
          break;
        case 'e':
          cell.isExit = true;
          cell.jelly = 1;
          break;
        default:
          break;
      }
      row.push(cell);
    }
    grid.push(row);
  }
  return grid;
}

interface IdCounter {
  next: number;
}

function placeInitialIngredients(level: LevelDef, grid: Cell[][], ids: IdCounter): IngredientType[] {
  const remaining: IngredientType[] = [];
  for (const rule of level.ingredientSpawns ?? []) {
    const target = Math.min(rule.count, rule.maxOnBoard);
    let placed = 0;
    const cols = rule.spawnCols.filter((c) => c >= 0 && c < level.cols);
    for (let i = 0; placed < target && cols.length && i < cols.length * level.rows; i++) {
      const col = cols[i % cols.length];
      for (let r = 0; r < level.rows; r++) {
        const cell = grid[r][col];
        if (canHoldCandy(cell) && !cell.isExit && !cell.candy) {
          cell.candy = { id: ids.next++, color: 'none', special: 'none', ingredient: rule.type };
          placed++;
          break;
        }
      }
    }
    for (let i = placed; i < rule.count; i++) remaining.push(rule.type);
  }
  return remaining;
}

function fillEmpty(grid: Cell[][], colors: readonly CandyColor[], rng: Rng, ids: IdCounter): void {
  for (const row of grid)
    for (const cell of row) {
      if (!canHoldCandy(cell) || cell.candy) continue;
      cell.candy = { id: ids.next++, color: pickColor(colors, rng, forbiddenColorsAt(grid, cell.row, cell.col)), special: 'none' };
    }
}

function maxCandyId(grid: Cell[][]): number {
  let max = 0;
  for (const row of grid) for (const cell of row) if (cell.candy && cell.candy.id > max) max = cell.candy.id;
  return max;
}

/** Build a playing state around an existing grid (used by createGameState, fixtures and tutorials). */
export function createStateFromGrid(level: LevelDef, grid: Cell[][], overrides: Partial<GameState> = {}): GameState {
  const base: GameState = {
    level,
    grid,
    score: 0,
    movesLeft: level.moves,
    objectives: [],
    status: 'playing',
    nextCandyId: maxCandyId(grid) + 1,
    ingredientsRemainingToSpawn: [],
    chocolateClearedThisTurn: false,
    totalMovesMade: 0,
    maxCascade: 0,
    collectedOrders: {},
    collectedIngredients: {},
  };
  const state: GameState = { ...base, ...overrides };
  state.objectives = computeObjectivesProgress(level, state.grid, state.score, state.collectedOrders, state.collectedIngredients);
  return state;
}

export function createGameState(level: LevelDef, rng: Rng = Math.random): GameState {
  let last: { grid: Cell[][]; remaining: IngredientType[]; ids: IdCounter } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const ids: IdCounter = { next: 1 };
    const grid = parseLayout(level);
    const remaining = placeInitialIngredients(level, grid, ids);
    fillEmpty(grid, level.colors, rng, ids);
    last = { grid, remaining, ids };
    if (findMatches(grid).length === 0 && findValidMoves(grid).length > 0) break;
  }
  const { grid, remaining, ids } = last!;
  if (findValidMoves(grid).length === 0) forceValidMove(grid, level.colors, rng);
  return createStateFromGrid(level, grid, { nextCandyId: ids.next, ingredientsRemainingToSpawn: remaining });
}

export function applyBakersGift(
  state: GameState,
  winStreak: number,
  rng: Rng = Math.random,
): { state: GameState; gifts: Array<{ pos: GridPos; special: SpecialType }> } {
  const gifts: Array<{ pos: GridPos; special: SpecialType }> = [];
  const next = cloneState(state);
  if (state.level.mode === 'zen' || winStreak < 1) return { state: next, gifts };

  const candidates = next.grid.flat().filter((cell) => isSwappableCell(cell) && isRegularCandy(cell.candy));
  const specials: SpecialType[] = [rng() < 0.5 ? 'striped-h' : 'striped-v'];
  if (winStreak >= 3) specials.push('wrapped');
  if (winStreak >= 2) specials.push('seeker');
  for (const special of specials) {
    if (!candidates.length) break;
    const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
    const [cell] = candidates.splice(index, 1);
    cell.candy!.special = special;
    gifts.push({ pos: { row: cell.row, col: cell.col }, special });
  }
  return { state: next, gifts };
}

export function restoreZenState(level: LevelDef, zen: ZenSaveState): GameState {
  return createStateFromGrid(level, cloneGrid(zen.grid), {
    score: zen.score,
    maxCascade: zen.maxCascade,
    totalMovesMade: zen.totalMovesMade,
    nextCandyId: zen.nextCandyId,
  });
}

const SHAPE_PRIORITY = { line5: 50, lt: 40, square2x2: 35, line4: 30, line3: 10 } as const;

function swapPriority(grid: Cell[][], from: GridPos, to: GridPos): number {
  const a = getCell(grid, from)!;
  const b = getCell(grid, to)!;
  if (isSpecialComboPair(a.candy, b.candy)) return 100;
  const ca = a.candy;
  a.candy = b.candy;
  b.candy = ca;
  try {
    const fk = posKey(from);
    const tk = posKey(to);
    let best = 0;
    for (const g of findMatches(grid, [from, to])) {
      if (!g.cells.some((p) => posKey(p) === fk || posKey(p) === tk)) continue;
      best = Math.max(best, SHAPE_PRIORITY[g.shape]);
    }
    return best;
  } finally {
    b.candy = a.candy;
    a.candy = ca;
  }
}

export function findValidMoves(grid: Cell[][]): ValidMove[] {
  const moves: ValidMove[] = [];
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < grid[r].length; c++)
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
      ] as const) {
        const from = { row: r, col: c };
        const to = { row: r + dr, col: c + dc };
        if (!getCell(grid, to) || !canSwap(grid, from, to)) continue;
        moves.push({ from, to, priority: swapPriority(grid, from, to) });
      }
  return moves.sort((x, y) => y.priority - x.priority);
}

// Each template is [a, b, t, d]: swapping t with d puts d's colour on t and lines up a, b, t.
type Offset = [number, number];
const H_TEMPLATES: Array<[Offset, Offset, Offset, Offset]> = [
  [[0, 0], [0, 1], [0, 2], [0, 3]],
  [[0, 0], [0, 1], [0, 2], [1, 2]],
  [[0, 0], [0, 1], [0, 2], [-1, 2]],
  [[0, 0], [0, 2], [0, 1], [1, 1]],
  [[0, 0], [0, 2], [0, 1], [-1, 1]],
  [[0, 1], [0, 2], [0, 0], [0, -1]],
  [[0, 1], [0, 2], [0, 0], [1, 0]],
  [[0, 1], [0, 2], [0, 0], [-1, 0]],
];
const TEMPLATES = [
  ...H_TEMPLATES,
  ...H_TEMPLATES.map((t) => t.map(([dr, dc]) => [dc, dr] as Offset) as [Offset, Offset, Offset, Offset]),
];

/**
 * Last resort: recolour a few regular candies so a guaranteed three-match swap exists
 * without creating any match on the board. Returns false if the board cannot host one.
 */
export function forceValidMove(grid: Cell[][], colors: readonly CandyColor[], rng: Rng): boolean {
  const pool = colorPool(colors);
  const recolorable = (p: GridPos, mustSwap: boolean) => {
    const cell = getCell(grid, p);
    if (!canHoldCandy(cell) || !isRegularCandy(cell.candy)) return false;
    return mustSwap ? !cell.locked : true;
  };
  const start = Math.floor(rng() * pool.length);
  const order = pool.map((_, i) => pool[(start + i) % pool.length]);
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < grid[r].length; c++)
      for (const tpl of TEMPLATES) {
        const [a, b, t, d] = tpl.map(([dr, dc]) => ({ row: r + dr, col: c + dc }));
        if (!recolorable(a, false) || !recolorable(b, false) || !recolorable(t, true) || !recolorable(d, true)) continue;
        const cells = [a, b, t, d].map((p) => getCell(grid, p)!.candy!);
        const saved = cells.map((k) => k.color);
        for (const x of order)
          for (const y of order) {
            if (x === y) continue;
            cells[0].color = x;
            cells[1].color = x;
            cells[3].color = x;
            cells[2].color = y;
            if (findMatches(grid).length === 0 && canSwap(grid, t, d)) return true;
          }
        cells.forEach((k, i) => (k.color = saved[i]));
      }
  return false;
}

function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function shuffleBoard(
  state: GameState,
  rng: Rng = Math.random,
): { grid: Cell[][]; mappings: Array<{ candyId: number; from: GridPos; to: GridPos }> } {
  const grid = cloneGrid(state.grid);
  const positions: GridPos[] = [];
  const candies: Candy[] = [];
  const original = new Map<number, GridPos>();
  for (const row of grid)
    for (const cell of row) {
      if (!isSwappableCell(cell) || cell.candy!.ingredient) continue;
      positions.push({ row: cell.row, col: cell.col });
      candies.push(cell.candy!);
      original.set(cell.candy!.id, { row: cell.row, col: cell.col });
    }
  const place = (order: Candy[]) => positions.forEach((p, i) => (grid[p.row][p.col].candy = order[i]));

  let done = false;
  let lastClean: Candy[] | null = findMatches(grid).length === 0 ? candies : null;
  for (let attempt = 0; attempt < 200 && candies.length; attempt++) {
    const order = shuffleInPlace([...candies], rng);
    place(order);
    if (findMatches(grid).length) continue;
    lastClean = order;
    if (findValidMoves(grid).length) {
      done = true;
      break;
    }
  }
  if (!done) {
    if (lastClean) place(lastClean);
    else {
      // No clean arrangement found: recolour regular candies to remove every match.
      for (const p of positions) {
        const candy = grid[p.row][p.col].candy!;
        if (!isRegularCandy(candy)) continue;
        const forbidden = forbiddenColorsAt(grid, p.row, p.col);
        if (forbidden.has(candy.color as CandyColor)) candy.color = pickColor(state.level.colors, rng, forbidden);
      }
    }
    if (findValidMoves(grid).length === 0) forceValidMove(grid, state.level.colors, rng);
  }

  const mappings: Array<{ candyId: number; from: GridPos; to: GridPos }> = [];
  for (const p of positions) {
    const candy = grid[p.row][p.col].candy!;
    const from = original.get(candy.id)!;
    if (from.row !== p.row || from.col !== p.col) mappings.push({ candyId: candy.id, from, to: { ...p } });
  }
  return { grid, mappings };
}

export function calculateStars(score: number, thresholds: [number, number, number]): 0 | 1 | 2 | 3 {
  if (score >= thresholds[2]) return 3;
  if (score >= thresholds[1]) return 2;
  if (score >= thresholds[0]) return 1;
  return 0;
}

function isStriped(s: SpecialType | undefined): boolean {
  return s === 'striped-h' || s === 'striped-v';
}

/** Whether clearing this candy counts toward an order objective. */
export function candyMatchesOrder(obj: ObjectiveTarget, candy: Candy): boolean {
  if (obj.kind !== 'order' || candy.ingredient) return false;
  const wantsSpecial = !!obj.special && obj.special !== 'none';
  if (!obj.color && !wantsSpecial) return false;
  if (obj.color && candy.color !== obj.color) return false;
  if (wantsSpecial) {
    if (isStriped(obj.special)) return isStriped(candy.special);
    return candy.special === obj.special;
  }
  return true;
}

export function computeObjectivesProgress(
  level: LevelDef,
  grid: Cell[][],
  score: number,
  collectedOrders: Record<string, number>,
  collectedIngredients: Record<string, number>,
): ObjectiveProgress[] {
  let jellyRemaining = 0;
  for (const row of grid) for (const cell of row) if (cell.playable && cell.jelly > 0) jellyRemaining += cell.jelly;
  return level.objectives.map((obj) => {
    let current = 0;
    let completed = false;
    switch (obj.kind) {
      case 'score':
        current = score;
        completed = score >= obj.target;
        break;
      case 'jelly':
        completed = jellyRemaining === 0;
        current = completed ? obj.target : Math.max(0, obj.target - jellyRemaining);
        break;
      case 'ingredients':
        current = obj.ingredient
          ? collectedIngredients[obj.ingredient] ?? 0
          : Object.values(collectedIngredients).reduce((a, b) => a + b, 0);
        completed = current >= obj.target;
        current = Math.min(current, obj.target);
        break;
      case 'order':
        current = collectedOrders[obj.id] ?? 0;
        completed = current >= obj.target;
        current = Math.min(current, obj.target);
        break;
    }
    return { ...obj, current, completed };
  });
}

const SPEC_COLORS: Record<string, CandyColor> = { r: 'red', o: 'orange', y: 'yellow', g: 'green', b: 'blue', p: 'purple' };
const SPEC_SPECIALS: Record<string, SpecialType> = { h: 'striped-h', v: 'striped-v', w: 'wrapped', s: 'seeker' };

/**
 * Build a grid from a compact text spec (fixtures, tutorials, debugging).
 * One string per row, whitespace-separated tokens:
 *   r o y g b p   regular candy, optionally followed by h | v | w | s (striped-h, striped-v, wrapped, seeker)
 *   B             colour bomb       I / N   cherry / hazelnut ingredient
 *   .             empty playable    #       hole
 *   1 2 3         frosting layers   X       chocolate
 * Flags after ':' — j (jelly 1), J (jelly 2), L (locked), E (exit). Example: `rh:jL`.
 */
export function parseBoardSpec(spec: string[]): Cell[][] {
  let id = 1;
  return spec.map((line, r) =>
    line
      .trim()
      .split(/\s+/)
      .map((token, c) => {
        const cell = blankCell(r, c);
        const [body, flags = ''] = token.split(':');
        if (flags.includes('j')) cell.jelly = 1;
        if (flags.includes('J')) cell.jelly = 2;
        if (flags.includes('K')) {
          cell.locked = true;
          cell.lockLayers = 3;
        } else if (flags.includes('M')) {
          cell.locked = true;
          cell.lockLayers = 2;
        } else if (flags.includes('L')) {
          cell.locked = true;
          cell.lockLayers = 1;
        }
        if (flags.includes('E')) cell.isExit = true;
        if (body === '#') cell.playable = false;
        else if (body === 'X') cell.chocolate = true;
        else if (body === '1' || body === '2' || body === '3') cell.frosting = Number(body) as 1 | 2 | 3;
        else if (body === 'B') cell.candy = { id: id++, color: 'none', special: 'color-bomb' };
        else if (body === 'I' || body === 'N')
          cell.candy = { id: id++, color: 'none', special: 'none', ingredient: body === 'I' ? 'cherry' : 'hazelnut' };
        else if (body !== '.') {
          const color = SPEC_COLORS[body[0]];
          if (!color) throw new Error(`Unknown board token "${token}" at ${r},${c}`);
          cell.candy = { id: id++, color, special: SPEC_SPECIALS[body[1] ?? ''] ?? 'none' };
        }
        return cell;
      }),
  );
}
