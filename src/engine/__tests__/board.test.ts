import { describe, expect, it } from 'vitest';
import {
  calculateStars,
  cloneGrid,
  computeObjectivesProgress,
  createGameState,
  createSeededRng,
  createStateFromGrid,
  executeSugarCrush,
  executeSwap,
  findMatches,
  findValidMoves,
  parseBoardSpec,
  shuffleBoard,
} from '../index';
import type { Cell, GameState, GridPos, LevelDef } from '../index';

function level(extra: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 1,
    chapterId: 1,
    name: 'Test',
    subtitle: '',
    rows: 9,
    cols: 9,
    colors: ['red', 'orange', 'yellow', 'green', 'blue'],
    moves: 20,
    starThresholds: [1000, 5000, 10000],
    objectives: [{ id: 'score', kind: 'score', label: 'Score', target: 10_000_000 }],
    layout: Array.from({ length: 9 }, () => '.........'),
    ...extra,
  };
}
function specLevel(spec: string[], extra: Partial<LevelDef> = {}): LevelDef {
  return level({ rows: spec.length, cols: spec[0].trim().split(/\s+/).length, layout: [], ...extra });
}
function stateOf(spec: string[], extra: Partial<LevelDef> = {}, overrides: Partial<GameState> = {}): GameState {
  return createStateFromGrid(specLevel(spec, extra), parseBoardSpec(spec), overrides);
}
const p = (row: number, col: number): GridPos => ({ row, col });
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};
const DEADLOCK = ['r g b r g', 'g b r g b', 'b r g b r', 'r g b r g', 'g b r g b'];

describe('createGameState', () => {
  const layoutLevel = level({
    rows: 5,
    cols: 5,
    layout: ['#..j.', '.J1..', '.L.C.', '.23..', 'E.e..'],
  });

  it('parses every layout symbol', () => {
    const { grid } = createGameState(layoutLevel, createSeededRng(1));
    expect(grid[0][0]).toMatchObject({ playable: false, candy: null });
    expect(grid[0][3].jelly).toBe(1);
    expect(grid[1][1].jelly).toBe(2);
    expect(grid[1][2]).toMatchObject({ frosting: 1, candy: null });
    expect(grid[2][1].locked).toBe(true);
    expect(grid[2][1].candy).not.toBeNull();
    expect(grid[2][3]).toMatchObject({ chocolate: true, candy: null });
    expect(grid[3][1].frosting).toBe(2);
    expect(grid[3][2].frosting).toBe(3);
    expect(grid[4][0].isExit).toBe(true);
    expect(grid[4][2]).toMatchObject({ isExit: true, jelly: 1 });
    expect(grid[4][4]).toMatchObject({ playable: true, jelly: 0, isExit: false });
  });

  it('fills every open cell with a level colour, unique ids, no matches and at least one move', () => {
    const s = createGameState(layoutLevel, createSeededRng(2));
    const open = s.grid.flat().filter((c) => c.playable && c.frosting === 0 && !c.chocolate);
    expect(open.every((c) => c.candy && layoutLevel.colors.includes(c.candy.color as never))).toBe(true);
    const ids = s.grid.flat().flatMap((c) => (c.candy ? [c.candy.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.nextCandyId).toBeGreaterThan(Math.max(...ids));
    expect(findMatches(s.grid)).toEqual([]);
    expect(findValidMoves(s.grid).length).toBeGreaterThan(0);
    expect(s).toMatchObject({ status: 'playing', movesLeft: 20, score: 0, totalMovesMade: 0 });
    expect(s.objectives[0]).toMatchObject({ id: 'score', current: 0, completed: false });
  });

  it('is deterministic for a seed', () => {
    const a = createGameState(level(), createSeededRng(42));
    const b = createGameState(level(), createSeededRng(42));
    expect(JSON.stringify(a.grid)).toBe(JSON.stringify(b.grid));
  });

  it('never starts with a match and always has a move (40 seeds, 3-5 colours)', () => {
    for (let seed = 0; seed < 40; seed++) {
      const colors = (['red', 'green', 'blue', 'yellow', 'purple'] as const).slice(0, 3 + (seed % 3));
      const s = createGameState(level({ colors: [...colors] }), createSeededRng(seed));
      expect(findMatches(s.grid)).toEqual([]);
      expect(findValidMoves(s.grid).length).toBeGreaterThan(0);
    }
  });

  it('places starting ingredients up to maxOnBoard, never on an exit', () => {
    const lv = level({
      rows: 5,
      cols: 5,
      layout: ['.E...', '.....', '.....', '.....', 'EEEEE'],
      ingredientSpawns: [{ type: 'cherry', count: 3, maxOnBoard: 2, spawnCols: [1, 3] }],
    });
    const s = createGameState(lv, createSeededRng(5));
    const cherries = s.grid.flat().filter((c) => c.candy?.ingredient === 'cherry');
    expect(cherries).toHaveLength(2);
    expect(cherries.every((c) => !c.isExit)).toBe(true);
    expect(cherries.map((c) => [c.row, c.col])).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(s.ingredientsRemainingToSpawn).toEqual(['cherry']);
  });
});

describe('helpers', () => {
  it('cloneGrid is a deep copy', () => {
    const grid = parseBoardSpec(['r g', 'b r']);
    const copy = cloneGrid(grid);
    copy[0][0].candy!.color = 'blue';
    copy[0][1].jelly = 2;
    expect(grid[0][0].candy!.color).toBe('red');
    expect(grid[0][1].jelly).toBe(0);
  });

  it('calculateStars counts thresholds reached', () => {
    const t: [number, number, number] = [100, 200, 300];
    expect([0, 99, 100, 250, 300, 9999].map((s) => calculateStars(s, t))).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('computeObjectivesProgress covers score, jelly, ingredients and orders', () => {
    const lv = specLevel(['r:j g:J b'], {
      objectives: [
        { id: 'score', kind: 'score', label: 'Score', target: 500 },
        { id: 'jelly', kind: 'jelly', label: 'Jelly', target: 5 },
        { id: 'cherry', kind: 'ingredients', label: 'Cherries', ingredient: 'cherry', target: 2 },
        { id: 'reds', kind: 'order', label: 'Reds', color: 'red', target: 10 },
      ],
    });
    const progress = computeObjectivesProgress(lv, parseBoardSpec(['r:j g:J b']), 600, { reds: 12 }, { cherry: 1 });
    expect(progress.map((o) => [o.id, o.current, o.completed])).toEqual([
      ['score', 600, true],
      ['jelly', 2, false],
      ['cherry', 1, false],
      ['reds', 10, true],
    ]);
    const cleared = computeObjectivesProgress(lv, parseBoardSpec(['r g b']), 0, {}, {});
    expect(cleared[1]).toMatchObject({ current: 5, completed: true });
  });

  it('order objectives count cleared candies of the colour', () => {
    const s = stateOf(['r g r b g', 'b r g y b', 'g b y g r'], {
      objectives: [{ id: 'reds', kind: 'order', label: 'Reds', color: 'red', target: 3 }],
    });
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: createSeededRng(1) });
    expect(res.state.collectedOrders.reds).toBeGreaterThanOrEqual(3);
    expect(res.state.objectives[0].completed).toBe(true);
  });
});

describe('shuffleBoard', () => {
  it('turns a deadlocked board into a playable one with the same candies', () => {
    const s = stateOf(DEADLOCK);
    expect(findValidMoves(s.grid)).toEqual([]);
    const { grid, mappings } = shuffleBoard(s, createSeededRng(9));
    expect(findMatches(grid)).toEqual([]);
    expect(findValidMoves(grid).length).toBeGreaterThan(0);
    const ids = (g: Cell[][]) => g.flat().map((c) => c.candy!.id).sort((a, b) => a - b);
    expect(ids(grid)).toEqual(ids(s.grid));
    for (const m of mappings) {
      expect(s.grid[m.from.row][m.from.col].candy!.id).toBe(m.candyId);
      expect(grid[m.to.row][m.to.col].candy!.id).toBe(m.candyId);
    }
    expect(JSON.stringify(s.grid)).toBe(JSON.stringify(parseBoardSpec(DEADLOCK)));
  });

  it('places a guaranteed move when no arrangement has one', () => {
    const s = stateOf(['g b y g'], { colors: ['red', 'green', 'blue', 'yellow'] });
    const { grid } = shuffleBoard(s, createSeededRng(4));
    expect(findMatches(grid)).toEqual([]);
    expect(findValidMoves(grid).length).toBeGreaterThan(0);
  });
});

describe('turn outcome', () => {
  const spec = ['r g r b g', 'b r g y b', 'g b y g r'];
  const score = (target: number) => [{ id: 'score', kind: 'score' as const, label: 'Score', target }];

  it('objectives met with moves left → sugar-crush', () => {
    const res = executeSwap(stateOf(spec, { objectives: score(50), moves: 5 }), p(0, 1), p(1, 1), { rng: createSeededRng(1) });
    expect(res.state.status).toBe('sugar-crush');
    expect(res.state.movesLeft).toBe(4);
    expect(res.state.totalMovesMade).toBe(1);
  });

  it('objectives met on the last move → won', () => {
    const res = executeSwap(stateOf(spec, { objectives: score(50), moves: 1 }), p(0, 1), p(1, 1), { rng: createSeededRng(1) });
    expect(res.state.status).toBe('won');
  });

  it('out of moves with objectives open → lost, and further swaps are refused', () => {
    const res = executeSwap(stateOf(spec, { objectives: score(1e9), moves: 1 }), p(0, 1), p(1, 1), { rng: createSeededRng(1) });
    expect(res.state.status).toBe('lost');
    expect(executeSwap(res.state, p(0, 0), p(0, 1)).valid).toBe(false);
  });

  it('a free switch moves candies without a match and without using a move', () => {
    const s = stateOf(spec);
    const res = executeSwap(s, p(0, 0), p(1, 0), { freeSwitch: true, rng: createSeededRng(1) });
    expect(res.valid).toBe(true);
    expect(res.state.movesLeft).toBe(20);
    expect(res.state.grid[0][0].candy!.id).toBe(s.grid[1][0].candy!.id);
  });

  it('a deadlock after the move triggers an automatic shuffle', () => {
    // 1x4 row: r r g r → swap makes r r r g; refills are green, blue, yellow → g b y g has no move.
    const s = stateOf(['r r g r'], { colors: ['red', 'green', 'blue', 'yellow'], objectives: score(1e9), moves: 10 });
    const res = executeSwap(s, p(0, 3), p(0, 2), { rng: seq(0.3, 0.55, 0.8) });
    expect(res.valid).toBe(true);
    expect(res.didShuffle).toBe(true);
    const last = res.phases[res.phases.length - 1];
    expect(last.kind).toBe('shuffle');
    expect(last.events[0].type).toBe('shuffle');
    expect(findValidMoves(res.state.grid).length).toBeGreaterThan(0);
    expect(findMatches(res.state.grid)).toEqual([]);
  });

  it('every phase carries its own deep-cloned snapshot and the input state is untouched', () => {
    const s = stateOf(['r g r b g', 'b rh g r b', 'g b b g r', 'r g r b g']);
    const before = JSON.stringify(s);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: createSeededRng(3) });
    expect(JSON.stringify(s)).toBe(before);
    expect(res.phases.length).toBeGreaterThan(2);
    const grids = new Set(res.phases.map((ph) => ph.gridAfter));
    expect(grids.size).toBe(res.phases.length);
    for (const ph of res.phases) {
      expect(ph.gridAfter).not.toBe(res.state.grid);
      expect(ph.objectivesAfter).toHaveLength(1);
    }
    for (let i = 1; i < res.phases.length; i++) expect(res.phases[i].scoreAfter).toBeGreaterThanOrEqual(res.phases[i - 1].scoreAfter);
    const last = res.phases[res.phases.length - 1];
    expect(last.scoreAfter).toBe(res.state.score);
    expect(JSON.stringify(last.gridAfter)).toBe(JSON.stringify(res.state.grid));
    res.phases[1].gridAfter[3][0].candy = null;
    expect(res.state.grid[3][0].candy).not.toBeNull();
  });
});

describe('executeSugarCrush', () => {
  it('turns each move left into a striped candy, detonates everything, and wins', () => {
    const s = stateOf(DEADLOCK, {}, { status: 'sugar-crush', movesLeft: 3, score: 1000 });
    const res = executeSugarCrush(s, createSeededRng(8));
    expect(res.valid).toBe(true);
    expect(res.state.status).toBe('won');
    expect(res.state.movesLeft).toBe(0);
    const first = res.phases[0];
    expect(first.kind).toBe('sugar-crush');
    const comets = first.events.filter((e) => e.type === 'sugar-crush-comet');
    expect(comets).toHaveLength(3);
    for (const c of comets) if (c.type === 'sugar-crush-comet') expect(['striped-h', 'striped-v']).toContain(c.candy.special);
    expect(first.scoreAfter).toBe(1000 + 3 * 1500);
    expect(res.phases.some((ph) => ph.events.some((e) => e.type === 'laser'))).toBe(true);
    expect(res.state.grid.flat().some((c) => c.candy && c.candy.special !== 'none')).toBe(false);
    expect(res.state.score).toBeGreaterThan(1000 + 3 * 1500);
    expect(res.starsEarned).toBe(calculateStars(res.state.score, s.level.starThresholds));
  });

  it('refuses a lost game', () => {
    const s = stateOf(DEADLOCK, {}, { status: 'lost', movesLeft: 0 });
    expect(executeSugarCrush(s).valid).toBe(false);
  });
});
