import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZEN_CHAPTER, ZEN_LEVEL } from '../../levels';
import {
  clearZenSession,
  createDefaultSave,
  loadSave,
  recordLevelCompletion,
  resetWinStreak,
  savePlayerData,
  saveZenSession,
  STORAGE_KEY,
} from '../../state/storage';
import type { ZenSaveState } from '../../state/storageTypes';
import {
  applyBakersGift,
  applyHammerBooster,
  canSwap,
  createGameState,
  createResolveContext,
  createSeededRng,
  createStateFromGrid,
  executeSugarCrush,
  executeSwap,
  findMatches,
  findValidMoves,
  finishTurn,
  parseBoardSpec,
  pickSeekerTarget,
  posKey,
  restoreZenState,
} from '../index';
import type { AnimationEvent, GridPos, LevelDef, ResolutionPhase } from '../index';

const p = (row: number, col: number): GridPos => ({ row, col });
const rng = () => createSeededRng(31);
const eventsOf = <T extends AnimationEvent['type']>(phase: ResolutionPhase, type: T) =>
  phase.events.filter((e): e is Extract<AnimationEvent, { type: T }> => e.type === type);

function fixture(spec: string[], extra: Partial<LevelDef> = {}) {
  const grid = parseBoardSpec(spec);
  return createStateFromGrid({
    ...ZEN_LEVEL, id: 1, chapterId: 1, mode: 'saga', rows: grid.length, cols: grid[0].length, moves: 20, ...extra,
  }, grid);
}

function seekerBoard(overrides: Record<string, string>) {
  return fixture(Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 6 }, (_, col) => overrides[`${row},${col}`] ?? ['r', 'g', 'b'][(row + col) % 3]).join(' '),
  ));
}

describe('square matches', () => {
  it('finds a square with a locked candy and uses a swapped position inside it', () => {
    const grid = parseBoardSpec(['r:L r g', 'r r b']);
    const [group] = findMatches(grid, [p(0, 2), p(0, 1)]);
    expect(group).toEqual({
      shape: 'square2x2', color: 'red', spawnSpecial: 'seeker', spawnPos: p(0, 1),
      cells: [p(0, 0), p(0, 1), p(1, 0), p(1, 1)],
    });
    expect(findMatches(grid)[0].spawnPos).toEqual(p(0, 0));
  });

  it.each(['#', '1', 'X', 'I', 'B'])('ignores a square interrupted by %s', (blocker) => {
    expect(findMatches(parseBoardSpec(['r r', `r ${blocker}`]))).toEqual([]);
  });

  it('merges a plain line into the square while preserving the square spawn', () => {
    const groups = findMatches(parseBoardSpec(['r r r', 'r r b']));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ shape: 'square2x2', spawnPos: p(0, 0) });
    expect(groups[0].cells).toContainEqual(p(0, 2));
  });

  it('preserves the larger special when it covers the full square', () => {
    const groups = findMatches(parseBoardSpec(['r r r', 'r r r', 'r r r']));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ shape: 'lt', spawnSpecial: 'wrapped' });
  });

  it('recognizes a square-only swap in hints and creates the seeker at the swap', () => {
    const state = fixture(['r r g', 'r g r', 'b g b']);
    const from = p(1, 2);
    const to = p(1, 1);
    expect(canSwap(state.grid, from, to)).toBe(true);
    expect(findValidMoves(state.grid)).toContainEqual({ from: to, to: from, priority: 35 });
    const clear = executeSwap(state, from, to, { rng: rng() }).phases[1];
    expect(eventsOf(clear, 'special-spawn')).toEqual([
      { type: 'special-spawn', pos: to, candy: expect.objectContaining({ special: 'seeker', color: 'red' }) },
    ]);
  });
});

describe('Seeker targeting', () => {
  it('chooses double jelly, single jelly, below an ingredient, a blocker, and an active order in sequence', () => {
    const state = fixture(['I r g g:j', 'b 2 y r:J'], {
      objectives: [{ id: 'yellow', kind: 'order', label: 'Yellow', color: 'yellow', target: 5 }],
    });
    const exclude = new Set<string>();
    for (const expected of [p(1, 3), p(0, 3), p(1, 0), p(1, 1), p(1, 2), p(0, 1), p(0, 2)]) {
      expect(pickSeekerTarget(state.grid, state.objectives, exclude, () => 0)).toEqual(expected);
      exclude.add(posKey(expected));
    }
    expect(pickSeekerTarget(state.grid, state.objectives, exclude, () => 0)).toBeUndefined();
    state.objectives[0].completed = true;
    expect(pickSeekerTarget(state.grid, state.objectives, new Set(['1,3', '0,3', '1,0', '1,1']), () => 0)).toEqual(p(0, 1));
  });

  it('hits its four neighbors and chains a stripe at the remote smart target', () => {
    const state = seekerBoard({ '2,2': 'rs', '0,5': 'bh:J', '1,2': '2' });
    const clear = applyHammerBooster(state, p(2, 2), rng()).phases[0];
    expect(eventsOf(clear, 'seeker-fly')).toEqual([
      { type: 'seeker-fly', origin: p(2, 2), target: p(0, 5), payload: 'none', color: 'red' },
    ]);
    expect(eventsOf(clear, 'laser')).toEqual([expect.objectContaining({ origin: p(0, 5), orientation: 'h' })]);
    expect(clear.gridAfter[0][5].jelly).toBe(1);
    expect(clear.gridAfter[1][2].frosting).toBe(1);
    for (const { row, col } of [p(2, 1), p(2, 3), p(3, 2)]) expect(clear.gridAfter[row][col].candy).toBeNull();
    expect(clear.gridAfter[3][3].candy).not.toBeNull();
  });

  it('opens the cell under an ingredient so gravity can deliver it', () => {
    const state = seekerBoard({ '2,2': 'rs', '4,5': 'I', '5,5': 'b:E', '0,0': '3' });
    const result = applyHammerBooster(state, p(2, 2), rng());
    expect(eventsOf(result.phases[0], 'seeker-fly')[0].target).toEqual(p(5, 5));
    expect(result.phases[0].gridAfter[0][0].frosting).toBe(3);
    expect(result.state.collectedIngredients.cherry).toBe(1);
  });
});

describe('Seeker combos', () => {
  it('uses the destination for the cross and flies to three distinct targets', () => {
    const state = seekerBoard({ '2,1': 'rs', '2,2': 'gs', '0,0': 'b:J', '0,5': 'g:j', '5,5': '2' });
    const combo = executeSwap(state, p(2, 1), p(2, 2), { rng: rng() }).phases[1];
    expect(eventsOf(combo, 'seeker-fly')).toEqual([p(0, 0), p(0, 5), p(5, 5)].map((target) => ({
      type: 'seeker-fly', origin: p(2, 2), target, payload: 'none', color: 'red',
    })));
    expect(combo.gridAfter[0][0].jelly).toBe(1);
    expect(combo.gridAfter[0][5].jelly).toBe(0);
    expect(combo.gridAfter[5][5].frosting).toBe(1);
    for (const { row, col } of [p(1, 2), p(2, 3), p(3, 2)]) expect(combo.gridAfter[row][col].candy).toBeNull();
  });

  it.each([['bh', 'h', 'striped-h'], ['bv', 'v', 'striped-v']] as const)(
    'delivers a full laser for %s', (stripe, orientation, payload) => {
      const state = seekerBoard({ '2,1': stripe, '2,2': 'rs', '4,4': 'b:J' });
      const combo = executeSwap(state, p(2, 1), p(2, 2), { rng: rng() }).phases[1];
      expect(eventsOf(combo, 'seeker-fly')[0]).toMatchObject({ origin: p(2, 1), target: p(4, 4), payload });
      const [laser] = eventsOf(combo, 'laser');
      expect(laser).toMatchObject({ origin: p(4, 4), orientation, width: 1 });
      expect(laser.affected).toHaveLength(6);
      for (const { row, col } of laser.affected) expect(combo.gridAfter[row][col].candy).toBeNull();
    },
  );

  it('delivers a single full 3x3 wrapped blast', () => {
    const state = seekerBoard({ '2,1': 'rs', '2,2': 'gw', '4,4': 'b:J' });
    const result = executeSwap(state, p(2, 1), p(2, 2), { rng: rng() });
    const combo = result.phases[1];
    expect(eventsOf(combo, 'seeker-fly')[0]).toMatchObject({ target: p(4, 4), payload: 'wrapped' });
    const [boom] = eventsOf(combo, 'wrapped-boom');
    expect(boom).toMatchObject({ center: p(4, 4), radius: 1, stage: 1 });
    expect(boom.affected).toHaveLength(9);
    for (const { row, col } of boom.affected) expect(combo.gridAfter[row][col].candy).toBeNull();
    expect(result.phases.some((phase) => phase.kind === 'wrapped-second')).toBe(false);
  });

  it.each([false, true])('converts the entire color into seekers and launches each, reverse=%s', (reverse) => {
    const state = seekerBoard({ '2,1': 'B', '2,2': 'gs', '0,0': 'gw', '0,5': 'g:L', '5,5': 'r:J' });
    const pair = [p(2, 1), p(2, 2)] as const;
    const [from, to] = reverse ? [pair[1], pair[0]] : pair;
    const result = executeSwap(state, from, to, { rng: rng() });
    const [conversion, detonation] = result.phases.filter((phase) => phase.kind === 'combo');
    const [lightning] = eventsOf(conversion, 'lightning');
    expect(lightning).toMatchObject({ origin: p(2, 2), color: 'green', convertTo: 'seeker' });
    expect(lightning.targets).toHaveLength(state.grid.flat().filter((cell) => cell.candy?.color === 'green').length);
    const flights = eventsOf(detonation, 'seeker-fly');
    expect(flights.map((e) => e.origin)).toEqual(lightning.targets);
    expect(flights[0].target).toEqual(p(5, 5));
    for (const { row, col } of lightning.targets) {
      expect(conversion.gridAfter[row][col].candy?.special).toBe('seeker');
      expect(detonation.gridAfter[row][col]).toMatchObject({ candy: null, locked: false });
    }
    expect(eventsOf(detonation, 'wrapped-boom')).toEqual([]);
  });
});

describe('Endless Zen', () => {
  it('makes successful moves beyond the move limit and ignores completion', () => {
    const level = { ...ZEN_LEVEL, moves: 0, objectives: [{ id: 'score', kind: 'score' as const, label: 'Score', target: 1 }] };
    const random = rng();
    let state = createGameState(level, random);
    expect(ZEN_CHAPTER.id).toBe(ZEN_LEVEL.chapterId);
    for (let i = 0; i < 20; i++) {
      const [move] = findValidMoves(state.grid);
      const result = executeSwap(state, move.from, move.to, { rng: random });
      expect(result.valid).toBe(true);
      state = result.state;
      expect(state).toMatchObject({ status: 'playing', movesLeft: 0, totalMovesMade: i + 1 });
    }
    expect(state.objectives[0].completed).toBe(true);
    expect(executeSugarCrush(state, random)).toMatchObject({ valid: false, state, phases: [] });
  });

  it('shuffles a deadlocked board without changing scores, move counts, or candy ids', () => {
    const state = createGameState(ZEN_LEVEL, rng());
    const colors = ['red', 'green', 'blue'] as const;
    for (const cell of state.grid.flat()) cell.candy!.color = colors[(cell.row + cell.col) % colors.length];
    state.score = 41_000;
    state.totalMovesMade = 72;
    expect(findValidMoves(state.grid)).toEqual([]);
    const result = finishTurn(createResolveContext(state, rng()));
    expect(result).toMatchObject({ didShuffle: true, state: { status: 'playing', score: 41_000, totalMovesMade: 72 } });
    expect(result.phases.at(-1)?.kind).toBe('shuffle');
    expect(findMatches(result.state.grid)).toEqual([]);
    expect(findValidMoves(result.state.grid).length).toBeGreaterThan(0);
    expect(result.state.grid.flat().map((cell) => cell.candy!.id).sort())
      .toEqual(state.grid.flat().map((cell) => cell.candy!.id).sort());
  });

  it('refreshes a Zen board when the existing pieces cannot be shuffled into a move', () => {
    const state = createGameState(ZEN_LEVEL, rng());
    for (const cell of state.grid.flat()) cell.candy = null;
    const result = finishTurn(createResolveContext(state, rng()));
    expect(result).toMatchObject({ didShuffle: true, state: { status: 'playing' } });
    expect(findMatches(result.state.grid)).toEqual([]);
    expect(findValidMoves(result.state.grid).length).toBeGreaterThan(0);
    expect(result.state.grid[0][0].candy!.id).toBe(state.nextCandyId);
  });
});

describe("Baker's Gift", () => {
  it.each([
    [0, []], [1, ['striped-h']], [2, ['striped-h', 'seeker']], [3, ['striped-h', 'wrapped', 'seeker']],
    [7, ['striped-h', 'wrapped', 'seeker']],
  ] as const)('applies the expected gifts at streak %s to eligible candies only', (streak, specials) => {
    const state = fixture(['r:L I rh X', '1 g # b', 'r y . B']);
    const { state: next, gifts } = applyBakersGift(state, streak, () => 0);
    expect(next.grid).not.toBe(state.grid);
    expect(gifts.map((g) => g.special)).toEqual(specials);
    expect(new Set(gifts.map((g) => posKey(g.pos))).size).toBe(gifts.length);
    for (const { pos: { row, col }, special } of gifts) {
      expect(state.grid[row][col]).toMatchObject({ playable: true, locked: false, candy: { special: 'none' } });
      expect(state.grid[row][col].candy?.ingredient).toBeUndefined();
      expect(next.grid[row][col].candy?.special).toBe(special);
    }
    expect(next.grid[0]).toEqual(state.grid[0]);
  });

  it('can gift a vertical stripe and skips Zen', () => {
    expect(applyBakersGift(fixture(['r g b']), 1, () => 0.99).gifts[0].special).toBe('striped-v');
    expect(applyBakersGift(createGameState(ZEN_LEVEL, rng()), 3, rng()).gifts).toEqual([]);
  });
});

describe('Zen and streak storage', () => {
  function useLocalStorage() {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    });
    return data;
  }

  function session(): ZenSaveState {
    const { grid, nextCandyId } = createGameState(ZEN_LEVEL, rng());
    return { grid, nextCandyId, score: 25_000, maxCascade: 8, totalMovesMade: 72 };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('migrates old saves, counts consecutive Saga wins, and resets the streak', () => {
    useLocalStorage().set(STORAGE_KEY, JSON.stringify({ levels: { 1: { stars: 2, bestScore: 80 } } }));
    const migrated = loadSave();
    expect(migrated).toMatchObject({ winStreak: 0, zenBestScore: 0, zenBestCascade: 0, zenState: null, highestUnlockedLevel: 2 });
    const first = recordLevelCompletion(migrated, 2, 110, 3).save;
    const second = recordLevelCompletion(first, 2, 120, 3).save;
    savePlayerData(second);
    expect(loadSave().winStreak).toBe(2);
    expect(recordLevelCompletion(second, 0, 999, 3).save.winStreak).toBe(2);
    expect(resetWinStreak(second)).toMatchObject({ winStreak: 0, highestUnlockedLevel: 3 });
  });

  it('round-trips a Zen session, restores a deep copy, and keeps records after clearing', () => {
    useLocalStorage();
    const zen = session();
    const first = saveZenSession(createDefaultSave(), zen);
    const latest = { ...zen, score: 19_000, maxCascade: 9, totalMovesMade: 75 };
    savePlayerData(saveZenSession(first, latest));
    const reloaded = loadSave();
    expect(reloaded).toMatchObject({ zenState: latest, zenBestScore: 25_000, zenBestCascade: 9, winStreak: 0 });
    const restored = restoreZenState(ZEN_LEVEL, reloaded.zenState!);
    expect(restored).toMatchObject({ ...latest, status: 'playing', movesLeft: ZEN_LEVEL.moves, objectives: [] });
    expect(restored.grid).not.toBe(reloaded.zenState!.grid);
    expect(restored.grid[0][0].candy).not.toBe(reloaded.zenState!.grid[0][0].candy);
    const [move] = findValidMoves(restored.grid);
    const resumed = executeSwap(restored, move.from, move.to, { rng: rng() });
    expect(resumed.state).toMatchObject({ status: 'playing', totalMovesMade: latest.totalMovesMade + 1 });
    expect(clearZenSession(reloaded)).toMatchObject({ zenState: null, zenBestScore: 25_000, zenBestCascade: 9 });
  });

  it('drops invalid or ragged grids without losing high scores or streaks', () => {
    const data = useLocalStorage();
    const zen = session();
    for (const grid of [zen.grid.slice(1), [zen.grid[0].slice(1), ...zen.grid.slice(1)], [[null, ...zen.grid[0].slice(1)], ...zen.grid.slice(1)]]) {
      data.set(STORAGE_KEY, JSON.stringify({ zenState: { ...zen, grid }, zenBestScore: 30_000, zenBestCascade: 9, winStreak: 2 }));
      expect(loadSave()).toMatchObject({ zenState: null, zenBestScore: 30_000, zenBestCascade: 9, winStreak: 2 });
    }
  });
});
