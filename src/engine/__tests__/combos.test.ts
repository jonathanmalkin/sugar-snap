import { describe, expect, it } from 'vitest';
import {
  applyHammerBooster,
  createSeededRng,
  createStateFromGrid,
  executeSwap,
  parseBoardSpec,
} from '../index';
import type { AnimationEvent, Cell, GameState, GridPos, LevelDef, ResolutionPhase } from '../index';

// Diagonal three-colour background: no matches, no moves, so only the cells under test act.
const PAL = ['r', 'g', 'b'];
const bgColor = (r: number, c: number) => PAL[(r + c) % 3];
function board(rows: number, cols: number, overrides: Record<string, string> = {}): string[] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => overrides[`${r},${c}`] ?? bgColor(r, c)).join(' '),
  );
}
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
function stateOf(spec: string[]): GameState {
  return createStateFromGrid(level(spec), parseBoardSpec(spec));
}
const p = (row: number, col: number): GridPos => ({ row, col });
const at = (grid: Cell[][], r: number, c: number) => grid[r][c];
const phasesOf = (phases: ResolutionPhase[], kind: ResolutionPhase['kind']) => phases.filter((ph) => ph.kind === kind);
const eventsOf = <T extends AnimationEvent['type']>(phase: ResolutionPhase, type: T) =>
  phase.events.filter((e): e is Extract<AnimationEvent, { type: T }> => e.type === type);
const countColor = (grid: Cell[][], color: string) => grid.flat().filter((c) => c.candy?.color === color).length;
const rng = () => createSeededRng(7);

describe('special + special combos', () => {
  it('1. striped + striped clears the full row and column of the target cell', () => {
    const s = stateOf(board(7, 7, { '3,2': 'bh', '3,3': 'rv' }));
    const res = executeSwap(s, p(3, 2), p(3, 3), { rng: rng() });
    expect(res.valid).toBe(true);
    expect(res.phases[0].kind).toBe('swap');
    const combo = res.phases[1];
    expect(combo.kind).toBe('combo');
    expect(eventsOf(combo, 'laser').map((e) => e.orientation)).toEqual(['h', 'v']);
    const g = combo.gridAfter;
    for (let i = 0; i < 7; i++) {
      expect(at(g, 3, i).candy).toBeNull();
      expect(at(g, i, 3).candy).toBeNull();
    }
    expect(at(g, 0, 0).candy).not.toBeNull();
    expect(at(g, 6, 6).candy).not.toBeNull();
    expect(res.state.movesLeft).toBe(19);
  });

  it('2. striped + wrapped fires a three-wide cross', () => {
    const s = stateOf(board(7, 7, { '3,2': 'bw', '3,3': 'rh' }));
    const res = executeSwap(s, p(3, 2), p(3, 3), { rng: rng() });
    const combo = res.phases[1];
    const lasers = eventsOf(combo, 'laser');
    expect(lasers).toHaveLength(2);
    expect(lasers.every((l) => l.width === 3)).toBe(true);
    const g = combo.gridAfter;
    for (let i = 0; i < 7; i++)
      for (const k of [2, 3, 4]) {
        expect(at(g, k, i).candy).toBeNull();
        expect(at(g, i, k).candy).toBeNull();
      }
    expect(at(g, 0, 0).candy).not.toBeNull();
    expect(at(g, 0, 6).candy).not.toBeNull();
    expect(at(g, 6, 0).candy).not.toBeNull();
  });

  it('3. wrapped + wrapped explodes 5x5, falls, then explodes 5x5 again', () => {
    const s = stateOf(board(9, 9, { '4,3': 'gw', '4,4': 'bw' }));
    const res = executeSwap(s, p(4, 3), p(4, 4), { rng: rng() });
    const combo = res.phases[1];
    const [boom1] = eventsOf(combo, 'wrapped-boom');
    expect(boom1).toMatchObject({ center: p(4, 4), radius: 2, stage: 1 });
    const g = combo.gridAfter;
    for (let r = 2; r <= 6; r++)
      for (let c = 2; c <= 6; c++) {
        if (r === 4 && c === 4) expect(at(g, r, c).candy?.special).toBe('wrapped');
        else expect(at(g, r, c).candy).toBeNull();
      }
    expect(at(g, 0, 0).candy).not.toBeNull();
    expect(at(g, 4, 7).candy).not.toBeNull();

    const second = phasesOf(res.phases, 'wrapped-second');
    expect(second.length).toBeGreaterThanOrEqual(1);
    const [boom2] = eventsOf(second[0], 'wrapped-boom');
    // The marker fell through the cleared rows 5-6 and landed on row 6.
    expect(boom2).toMatchObject({ center: p(6, 4), radius: 2, stage: 2 });
    const secondIdx = res.phases.indexOf(second[0]);
    expect(res.phases.slice(1, secondIdx).some((ph) => ph.kind === 'gravity')).toBe(true);
  });

  it('4. colour bomb + regular zaps every candy of that colour', () => {
    const spec = board(5, 5, { '2,2': 'B' });
    const s = stateOf(spec);
    const blueBefore = countColor(s.grid, 'blue');
    const redBefore = countColor(s.grid, 'red');
    const res = executeSwap(s, p(2, 2), p(2, 3), { rng: rng() }); // (2,3) is blue
    const combo = res.phases[1];
    const [bolt] = eventsOf(combo, 'lightning');
    expect(bolt.color).toBe('blue');
    expect(bolt.convertTo).toBeUndefined();
    expect(bolt.targets).toHaveLength(blueBefore - 1);
    expect(countColor(combo.gridAfter, 'blue')).toBe(0);
    expect(countColor(combo.gridAfter, 'red')).toBe(redBefore);
    expect(combo.gridAfter.flat().some((c) => c.candy?.special === 'color-bomb')).toBe(false);
  });

  it('5. colour bomb + striped converts the colour to stripes, then fires them all', () => {
    const s = stateOf(board(5, 5, { '2,2': 'B', '2,3': 'bh' }));
    const blueBefore = countColor(s.grid, 'blue');
    const res = executeSwap(s, p(2, 2), p(2, 3), { rng: rng() });
    const [convert, detonate] = phasesOf(res.phases, 'combo');
    const [bolt] = eventsOf(convert, 'lightning');
    expect(bolt).toMatchObject({ color: 'blue', convertTo: 'striped' });
    expect(bolt.targets).toHaveLength(blueBefore - 1);
    for (const t of bolt.targets) expect(['striped-h', 'striped-v']).toContain(at(convert.gridAfter, t.row, t.col).candy?.special);
    expect(eventsOf(detonate, 'laser').length).toBeGreaterThanOrEqual(bolt.targets.length);
    expect(countColor(detonate.gridAfter, 'blue')).toBe(0);
  });

  it('6. colour bomb + wrapped converts the colour to wrapped, then detonates them all', () => {
    const s = stateOf(board(5, 5, { '2,2': 'B', '2,3': 'bw' }));
    const res = executeSwap(s, p(2, 2), p(2, 3), { rng: rng() });
    const [convert, detonate] = phasesOf(res.phases, 'combo');
    const [bolt] = eventsOf(convert, 'lightning');
    expect(bolt).toMatchObject({ color: 'blue', convertTo: 'wrapped' });
    for (const t of bolt.targets) expect(at(convert.gridAfter, t.row, t.col).candy?.special).toBe('wrapped');
    expect(eventsOf(detonate, 'wrapped-boom').length).toBeGreaterThanOrEqual(bolt.targets.length);
    expect(phasesOf(res.phases, 'wrapped-second').length).toBeGreaterThanOrEqual(1);
  });

  it('7. colour bomb + colour bomb wipes every candy and takes one layer off every blocker', () => {
    const spec = board(5, 5, {
      '0,0': 'r:j',
      '0,1': 'g:J',
      '4,4': '2',
      '4,0': 'X',
      '1,1': 'b:L',
      '2,2': 'B:j',
      '2,3': 'B',
    });
    const s = stateOf(spec);
    const res = executeSwap(s, p(2, 2), p(2, 3), { rng: rng() });
    const combo = res.phases[1];
    expect(eventsOf(combo, 'board-wipe')).toHaveLength(1);
    const g = combo.gridAfter;
    const candies = g.flat().filter((c) => c.candy);
    // Only the locked candy survives, with its lock gone.
    expect(candies.map((c) => [c.row, c.col])).toEqual([[1, 1]]);
    expect(at(g, 1, 1).locked).toBe(false);
    expect(at(g, 0, 0).jelly).toBe(0);
    expect(at(g, 0, 1).jelly).toBe(1);
    expect(at(g, 2, 2).jelly).toBe(0);
    expect(at(g, 4, 4).frosting).toBe(1);
    expect(at(g, 4, 0).chocolate).toBe(false);
    expect(eventsOf(combo, 'laser')).toHaveLength(0);
  });
});

describe('chain detonations', () => {
  it('a laser that hits another striped candy fires it too', () => {
    const s = stateOf(board(5, 5, { '2,0': 'bh', '2,4': 'rv' }));
    const res = applyHammerBooster(s, p(2, 0), rng());
    const clear = res.phases[0];
    const lasers = eventsOf(clear, 'laser');
    expect(lasers.map((l) => [l.orientation, l.origin.row, l.origin.col])).toEqual([
      ['h', 2, 0],
      ['v', 2, 4],
    ]);
    for (let i = 0; i < 5; i++) {
      expect(at(clear.gridAfter, 2, i).candy).toBeNull();
      expect(at(clear.gridAfter, i, 4).candy).toBeNull();
    }
  });

  it('two stripes in one row fire once each (cycle-safe)', () => {
    const s = stateOf(board(5, 5, { '2,0': 'bh', '2,3': 'bh' }));
    const res = applyHammerBooster(s, p(2, 0), rng());
    expect(eventsOf(res.phases[0], 'laser')).toHaveLength(2);
  });

  it('a laser that hits a colour bomb sets off its lightning', () => {
    const s = stateOf(board(5, 5, { '2,0': 'bh', '2,4': 'B' }));
    const res = applyHammerBooster(s, p(2, 0), rng());
    const [bolt] = eventsOf(res.phases[0], 'lightning');
    expect(bolt).toBeDefined();
    expect(countColor(res.phases[0].gridAfter, bolt.color)).toBe(0);
  });

  it('a striped candy inside a normal match fires its laser', () => {
    const s = stateOf(['r g r b g', 'b rh g r b', 'g b b g r', 'r g r b g']);
    const res = executeSwap(s, p(0, 1), p(1, 1), { rng: rng() });
    const clear = res.phases[1];
    expect(clear.kind).toBe('clear');
    const [laser] = eventsOf(clear, 'laser');
    expect(laser).toMatchObject({ orientation: 'h', origin: p(0, 1) });
    for (let c = 0; c < 5; c++) expect(at(clear.gridAfter, 0, c).candy).toBeNull();
  });
});

describe('wrapped double explosion', () => {
  it('explodes 3x3, falls with gravity, then explodes again where it lands', () => {
    const s = stateOf(board(5, 5, { '2,2': 'gw' }));
    const res = applyHammerBooster(s, p(2, 2), rng());
    const first = res.phases[0];
    const [boom1] = eventsOf(first, 'wrapped-boom');
    expect(boom1).toMatchObject({ center: p(2, 2), radius: 1, stage: 1 });
    expect(at(first.gridAfter, 2, 2).candy?.special).toBe('wrapped');
    for (const [r, c] of [
      [1, 1],
      [1, 3],
      [3, 2],
    ])
      expect(at(first.gridAfter, r, c).candy).toBeNull();
    expect(res.phases[1].kind).toBe('gravity');
    const second = phasesOf(res.phases, 'wrapped-second')[0];
    const [boom2] = eventsOf(second, 'wrapped-boom');
    expect(boom2).toMatchObject({ center: p(3, 2), radius: 1, stage: 2 });
    expect(second.gridAfter.flat().some((c) => c.candy?.id === at(s.grid, 2, 2).candy!.id)).toBe(false);
  });
});

describe('special creation from matches', () => {
  it('a four from a vertical swap leaves a vertical stripe at the swapped cell', () => {
    const s = stateOf(['r r g r b', 'g b r g b', 'b g b b r', 'g r g r b']);
    const res = executeSwap(s, p(1, 2), p(0, 2), { rng: rng() });
    const clear = res.phases[1];
    const [spawn] = eventsOf(clear, 'special-spawn');
    expect(spawn.pos).toEqual(p(0, 2));
    expect(spawn.candy).toMatchObject({ special: 'striped-v', color: 'red' });
    expect(at(clear.gridAfter, 0, 2).candy?.special).toBe('striped-v');
  });

  it('a five leaves a colour bomb', () => {
    const s = stateOf(['r r g r r', 'g b r b g', 'b g b g b']);
    const res = executeSwap(s, p(1, 2), p(0, 2), { rng: rng() });
    const clear = res.phases[1];
    expect(at(clear.gridAfter, 0, 2).candy).toMatchObject({ special: 'color-bomb', color: 'none' });
  });

  it('an L leaves a wrapped candy', () => {
    const s = stateOf(['r g b', 'r b g', 'g r r', 'r b g']);
    const res = executeSwap(s, p(3, 0), p(2, 0), { rng: rng() });
    const clear = res.phases[1];
    expect(at(clear.gridAfter, 2, 0).candy).toMatchObject({ special: 'wrapped', color: 'red' });
  });
});
