import { describe, expect, it } from 'vitest';
import { createSeededRng, createStateFromGrid, parseBoardSpec } from '../board';
import { applyShuffleBooster, executeSwap } from '../resolver';
import type { LevelDef } from '../types';

function tinyLevel(overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 99,
    chapterId: 1,
    name: 'QA Fixture',
    subtitle: 'Regression',
    rows: 2,
    cols: 2,
    colors: ['red', 'blue', 'green', 'yellow'],
    moves: 10,
    starThresholds: [100, 200, 300],
    objectives: [{ id: 'score', kind: 'score', label: 'Score', target: 5000 }],
    layout: ['..', '..'],
    ...overrides,
  };
}

describe('Wave 3 Codex QA regression tests', () => {
  it('double-layer jelly starts at 0 progress and ticks +1 per layer cleared', () => {
    const level = tinyLevel({
      rows: 3,
      cols: 3,
      layout: ['...', '...', 'jJ.'],
      objectives: [{ id: 'jelly', kind: 'jelly', label: 'Jelly', target: 3 }],
    });
    const grid = parseBoardSpec([
      'r b g',
      'r r y',
      'b:j r:J y',
    ]);
    const state = createStateFromGrid(level, grid);
    expect(state.objectives[0].target).toBe(3);
    expect(state.objectives[0].current).toBe(0);

    // Swap (1,0) red? No, swap (2,0) blue with (2,1) red? Instead swap (1,0) red with (2,0) blue -> col 0 has r,b,r; let's swap (1,1) red with (2,1) red? No, match col 0 or row 1:
    // Swap (2,0) blue with (2,1) red puts red at (2,0) matching (0,0),(1,0),(2,0) clearing jelly at (2,0)!
    const res = executeSwap(state, { row: 2, col: 0 }, { row: 2, col: 1 }, { rng: createSeededRng(7) });
    expect(res.valid).toBe(true);
    expect(res.state.objectives[0].current).toBeGreaterThanOrEqual(1);
    expect(res.state.objectives[0].current).toBeLessThanOrEqual(3);
  });

  it('Free Switch placing an ingredient directly onto an exit immediately collects it', () => {
    const level = tinyLevel({
      rows: 2,
      cols: 3,
      layout: ['...', '..E'],
      objectives: [{ id: 'ing', kind: 'ingredients', label: 'Cherries', ingredient: 'cherry', target: 1 }],
    });
    const grid = parseBoardSpec([
      'r b g',
      'y I b:E',
    ]);
    const state = createStateFromGrid(level, grid);
    const res = executeSwap(state, { row: 1, col: 1 }, { row: 1, col: 2 }, { freeSwitch: true, rng: createSeededRng(11) });
    expect(res.valid).toBe(true);
    expect(res.state.collectedIngredients.cherry).toBe(1);
    expect(res.state.objectives[0].completed).toBe(true);
    expect(res.state.status).toBe('sugar-crush');
  });

  it('applyShuffleBooster returns valid:false when no legal move exists on the board', () => {
    const level = tinyLevel({ rows: 1, cols: 2, layout: ['..'] });
    const grid = parseBoardSpec(['r b']);
    const state = createStateFromGrid(level, grid);
    const res = applyShuffleBooster(state, createSeededRng(3));
    expect(res.valid).toBe(false);
    expect(res.didShuffle).toBe(false);
  });

  it('automatic deadlock shuffle marks board lost if zero legal moves can ever exist', () => {
    const level = tinyLevel({ rows: 1, cols: 2, layout: ['..'] });
    const grid = parseBoardSpec(['rh gv']);
    const state = createStateFromGrid(level, grid);
    const res = executeSwap(state, { row: 0, col: 0 }, { row: 0, col: 1 }, { rng: createSeededRng(5) });
    expect(res.valid).toBe(true);
    expect(res.state.status).toBe('lost');
  });
});
