import { describe, expect, it } from 'vitest';
import {
  applyHammerBooster,
  applyShuffleBooster,
  canHoldCandy,
  canSwap,
  createSeededRng,
  createStateFromGrid,
  executeSwap,
  findMatches,
  findValidMoves,
  parseBoardSpec,
} from '../index';
import type { AnimationEvent, Cell, GameState, GridPos, LevelDef, ResolutionPhase } from '../index';

function level(spec: string[], extra: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 1,
    chapterId: 1,
    name: 'Test',
    subtitle: '',
    rows: spec.length,
    cols: spec[0].trim().split(/\s+/).length,
    colors: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    moves: 20,
    starThresholds: [1000, 5000, 10000],
    objectives: [{ id: 'score', kind: 'score', label: 'Score', target: 10_000_000 }],
    layout: [],
    ...extra,
  };
}
function stateOf(spec: string[], extra: Partial<LevelDef> = {}, overrides: Partial<GameState> = {}): GameState {
  return createStateFromGrid(level(spec, extra), parseBoardSpec(spec), overrides);
}
const p = (row: number, col: number): GridPos => ({ row, col });
const eventsOf = <T extends AnimationEvent['type']>(phase: ResolutionPhase, type: T) =>
  phase.events.filter((e): e is Extract<AnimationEvent, { type: T }> => e.type === type);
const allEvents = (phases: ResolutionPhase[]) => phases.flatMap((ph) => ph.events);
const rng = () => createSeededRng(11);
const emptyFillable = (grid: Cell[][]) => grid.flat().filter((c) => canHoldCandy(c) && !c.candy);

describe('jelly', () => {
  it('clearing a candy removes one jelly layer (1 → 0, 2 → 1)', () => {
    const s = stateOf(['r:j g r:J b g', 'b r g y b', 'g b y g r']);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    const clear = res.phases[1];
    expect(clear.gridAfter[0][0].jelly).toBe(0);
    expect(clear.gridAfter[0][2].jelly).toBe(1);
    expect(eventsOf(clear, 'jelly-clear').map((e) => e.remaining).sort()).toEqual([0, 1]);
    expect(clear.scoreAfter).toBeGreaterThanOrEqual(60 + 2000);
  });

  it('jelly objective tracks the cells left', () => {
    const s = stateOf(['r:j g r:j b g', 'b r g y b', 'g b y g r'], {
      objectives: [{ id: 'jelly', kind: 'jelly', label: 'Jelly', target: 2 }],
    });
    expect(s.objectives[0]).toMatchObject({ current: 0, completed: false });
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    expect(res.state.objectives[0]).toMatchObject({ current: 2, completed: true });
    expect(res.state.status).toBe('sugar-crush');
  });
});

describe('frosting', () => {
  it('takes one hit from an adjacent match at 1, 2 and 3 layers', () => {
    const s = stateOf(['r g r 1', '3 r 2 b', 'g b y g']);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    const g = res.phases[1].gridAfter;
    expect(g[0][3].frosting).toBe(0);
    expect(g[1][0].frosting).toBe(2);
    expect(g[1][2].frosting).toBe(1);
    expect(eventsOf(res.phases[1], 'blocker-hit').filter((e) => e.blocker === 'frosting')).toHaveLength(3);
    // The freed cell refills.
    expect(res.state.grid[0][3].candy).not.toBeNull();
  });

  it('is hit directly by a laser but only once per blast', () => {
    const s = stateOf(['bh r 3 g', 'g y b r']);
    const res = applyHammerBooster(s, p(0, 0), rng());
    expect(res.phases[0].gridAfter[0][2].frosting).toBe(2);
  });

  it('cannot be swapped', () => {
    const s = stateOf(['r 1 r', 'g r g']);
    expect(executeSwap(s, p(0, 1), p(1, 1)).valid).toBe(false);
  });
});

describe('licorice locks', () => {
  it('a match breaks the lock and the candy survives', () => {
    const s = stateOf(['r:L g r b', 'b r g y', 'g b y g']);
    const lockedId = s.grid[0][0].candy!.id;
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    const g = res.phases[1].gridAfter;
    expect(g[0][0].locked).toBe(false);
    expect(g[0][0].candy?.id).toBe(lockedId);
    expect(g[0][1].candy).toBeNull();
    expect(g[0][2].candy).toBeNull();
    expect(eventsOf(res.phases[1], 'blocker-hit').some((e) => e.blocker === 'lock')).toBe(true);
  });

  it('a locked candy cannot be swapped and an illegal swap costs nothing', () => {
    const s = stateOf(['r:L g r b', 'g r g y', 'g b y g']);
    expect(canSwap(s.grid, p(0, 0), p(0, 1))).toBe(false);
    const res = executeSwap(s, p(0, 0), p(0, 1));
    expect(res.valid).toBe(false);
    expect(res.state.movesLeft).toBe(20);
    expect(res.phases[0].events[0]).toMatchObject({ type: 'swap', valid: false });
  });

  it('a blast breaks the lock without clearing the candy', () => {
    const s = stateOf(['bh r g:L y', 'g y b r']);
    const res = applyHammerBooster(s, p(0, 0), rng());
    expect(res.phases[0].gridAfter[0][2]).toMatchObject({ locked: false });
    expect(res.phases[0].gridAfter[0][2].candy?.color).toBe('green');
  });
});

describe('chocolate (static blocker)', () => {
  it('an adjacent match clears the chocolate block cleanly', () => {
    const s = stateOf(['r g r X', 'b r g y', 'g b y o', 'p o p X']);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    expect(res.phases[1].gridAfter[0][3].chocolate).toBe(false);
    expect(res.state.chocolateClearedThisTurn).toBe(true);
    expect(res.phases.some((ph) => ph.kind === 'chocolate')).toBe(false);
    expect(res.state.grid[3][3].chocolate).toBe(true);
  });

  it('stays static and never spreads even when no chocolate is cleared', () => {
    const s = stateOf(['r g r y', 'b r g y', 'g b y o', 'p o p X']);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    expect(res.phases.some((ph) => ph.kind === 'chocolate')).toBe(false);
    expect(res.state.grid.flat().filter((c) => c.chocolate)).toHaveLength(1);
    expect(res.state.grid[3][3].chocolate).toBe(true);
  });

  it('is destroyed by a laser', () => {
    const s = stateOf(['bh r X y', 'g y b r']);
    const res = applyHammerBooster(s, p(0, 0), rng());
    expect(res.phases[0].gridAfter[0][2].chocolate).toBe(false);
    expect(res.state.chocolateClearedThisTurn).toBe(true);
  });
});

describe('ingredients', () => {
  const spec = ['I g b y', 'r o y g', 'r b g o', 'o:E r p b'];
  const extra: Partial<LevelDef> = {
    objectives: [{ id: 'cherries', kind: 'ingredients', label: 'Cherries', ingredient: 'cherry', target: 2 }],
    ingredientSpawns: [{ type: 'cherry', count: 2, maxOnBoard: 1, spawnCols: [0] }],
  };

  it('falls to the exit, is collected, and the next one spawns within maxOnBoard', () => {
    const s = stateOf(spec, extra, { ingredientsRemainingToSpawn: ['cherry'] });
    const cherryId = s.grid[0][0].candy!.id;
    const res = executeSwap(s, p(3, 0), p(3, 1), { rng: rng() });
    const collect = allEvents(res.phases).filter((e) => e.type === 'ingredient-collect');
    expect(collect[0]).toEqual({ type: 'ingredient-collect', pos: p(3, 0), ingredient: 'cherry', candyId: cherryId });
    // The second cherry only enters after the first leaves; a cascade may carry it out this turn too.
    expect(res.state.ingredientsRemainingToSpawn).toEqual([]);
    expect(res.state.collectedIngredients.cherry).toBe(collect.length);
    const onBoard = res.state.grid.flat().filter((c) => c.candy?.ingredient === 'cherry');
    expect(onBoard.length + collect.length).toBe(2);
    expect(res.state.objectives[0]).toMatchObject({ current: collect.length, completed: collect.length === 2 });
    // Never more than maxOnBoard at any moment.
    for (const ph of res.phases)
      expect(ph.gridAfter.flat().filter((c) => c.candy?.ingredient === 'cherry').length).toBeLessThanOrEqual(1);
    expect(res.state.score).toBeGreaterThanOrEqual(10000);
  });

  it('is not destroyed by blasts', () => {
    const s = stateOf(['bh I g y', 'g y b r']);
    const res = applyHammerBooster(s, p(0, 0), rng());
    expect(res.phases[0].gridAfter[0][1].candy?.ingredient).toBe('cherry');
  });

  it('the hammer refuses an ingredient', () => {
    const s = stateOf(['I g b', 'g b r']);
    expect(applyHammerBooster(s, p(0, 0)).valid).toBe(false);
  });
});

describe('gravity', () => {
  it('candies fall straight through holes', () => {
    const s = stateOf(['r g b', '# y o', 'g p y']);
    const redId = s.grid[0][0].candy!.id;
    const res = applyHammerBooster(s, p(2, 0), rng());
    const gravity = res.phases.find((ph) => ph.kind === 'gravity')!;
    const [ev] = eventsOf(gravity, 'gravity');
    expect(ev.moves).toContainEqual(expect.objectContaining({ candyId: redId, from: p(0, 0), to: p(2, 0), isNew: false }));
    expect(ev.moves.some((m) => m.isNew && m.to.row === 0 && m.to.col === 0)).toBe(true);
    expect(res.state.grid[1][0].candy).toBeNull();
  });

  it('candies slide diagonally under frosting so no pocket stays empty', () => {
    const s = stateOf(['r 3 b', 'g y o', 'b p g']);
    const res = applyHammerBooster(s, p(1, 1), rng());
    const gravity = res.phases.find((ph) => ph.kind === 'gravity')!;
    const [ev] = eventsOf(gravity, 'gravity');
    const slide = ev.moves.find((m) => m.to.row === 1 && m.to.col === 1)!;
    expect(slide.from.row).toBe(0);
    expect([0, 2]).toContain(slide.from.col);
    expect(emptyFillable(res.state.grid)).toEqual([]);
  });

  it('locked candies do not fall and candies slide around them', () => {
    const s = stateOf(['r g:L b', 'g y o', 'b p g']);
    const lockedId = s.grid[0][1].candy!.id;
    const res = applyHammerBooster(s, p(1, 1), rng());
    expect(res.state.grid[0][1].candy?.id).toBe(lockedId);
    expect(res.state.grid[0][1].locked).toBe(true);
    expect(emptyFillable(res.state.grid)).toEqual([]);
  });
});

describe('boosters', () => {
  it('the hammer clears one candy without using a move', () => {
    const s = stateOf(['r g b', 'g b r', 'b r g']);
    const res = applyHammerBooster(s, p(1, 1), rng());
    expect(res.valid).toBe(true);
    expect(res.phases[0].events[0]).toEqual({ type: 'booster-hammer', pos: p(1, 1) });
    expect(res.phases[0].gridAfter[1][1].candy).toBeNull();
    expect(res.state.movesLeft).toBe(20);
    expect(emptyFillable(res.state.grid)).toEqual([]);
  });

  it('the hammer takes one layer off frosting and refuses holes', () => {
    const s = stateOf(['r 2 b', 'g # r']);
    expect(applyHammerBooster(s, p(0, 1), rng()).state.grid[0][1].frosting).toBe(1);
    expect(applyHammerBooster(s, p(1, 1)).valid).toBe(false);
  });

  it('shuffle keeps blockers, locks and ingredients in place and leaves a playable board', () => {
    const spec = [
      'r g b r g b',
      'g b:L r g rh r',
      'b r g 2 r g',
      'r g I r X b',
      'g b r g b r',
      'b r g bw r g',
    ];
    const s = stateOf(spec);
    const res = applyShuffleBooster(s, createSeededRng(3));
    expect(res.valid).toBe(true);
    expect(res.didShuffle).toBe(true);
    expect(res.phases).toHaveLength(1);
    expect(res.phases[0].kind).toBe('shuffle');
    const g = res.state.grid;
    expect(g[1][1].candy?.id).toBe(s.grid[1][1].candy!.id);
    expect(g[3][2].candy?.id).toBe(s.grid[3][2].candy!.id);
    expect(g[2][3].frosting).toBe(2);
    expect(g[3][4].chocolate).toBe(true);
    const ids = (grid: Cell[][]) => grid.flat().flatMap((c) => (c.candy ? [c.candy.id] : [])).sort((a, b) => a - b);
    expect(ids(g)).toEqual(ids(s.grid));
    const specials = (grid: Cell[][]) => grid.flat().filter((c) => c.candy && c.candy.special !== 'none').length;
    expect(specials(g)).toBe(specials(s.grid));
    expect(findMatches(g)).toEqual([]);
    expect(findValidMoves(g).length).toBeGreaterThan(0);
    expect(res.state.movesLeft).toBe(20);
    const [ev] = eventsOf(res.phases[0], 'shuffle');
    for (const m of ev.mappings) expect(g[m.to.row][m.to.col].candy?.id).toBe(m.candyId);
  });
});
