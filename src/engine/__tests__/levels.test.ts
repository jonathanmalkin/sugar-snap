import { describe, expect, it } from 'vitest';
import { CHAPTERS, LEVELS } from '../../levels';
import { createGameState, createSeededRng, findValidMoves } from '../board';
import { findMatches } from '../matcher';
import { executeSwap } from '../resolver';

describe('25-level Saga integration with engine', () => {
  it('has 5 chapters covering all 25 unique levels', () => {
    expect(CHAPTERS).toHaveLength(5);
    expect(LEVELS).toHaveLength(25);
    const ids = LEVELS.map((l) => l.id);
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  for (const level of LEVELS) {
    it(`Level ${level.id} (${level.name}) initializes cleanly with valid moves and playable first swap`, () => {
      const rng = createSeededRng(1000 + level.id * 37);
      const state = createGameState(level, rng);

      expect(state.status).toBe('playing');
      expect(state.grid).toHaveLength(level.rows);
      expect(state.grid[0]).toHaveLength(level.cols);

      // No accidental initial matches
      expect(findMatches(state.grid)).toHaveLength(0);

      // Guaranteed at least 1 valid opening move
      const moves = findValidMoves(state.grid);
      expect(moves.length).toBeGreaterThan(0);

      // Exact jelly objective count matches board jelly layers AND starts at 0 progress
      const jellyObj = state.objectives.find((o) => o.kind === 'jelly');
      if (jellyObj) {
        let totalJelly = 0;
        for (const row of state.grid) {
          for (const cell of row) totalJelly += cell.jelly;
        }
        expect(jellyObj.target).toBe(totalJelly);
        expect(jellyObj.current).toBe(0);
        expect(jellyObj.completed).toBe(false);
      }

      // Every ingredient level exits across the entire playable bottom row so donuts can never get trapped
      if (level.ingredientSpawns && level.ingredientSpawns.length > 0) {
        const bottomRow = state.grid[state.grid.length - 1];
        for (const cell of bottomRow) {
          if (cell.playable) expect(cell.isExit).toBe(true);
        }
      }

      // Executing the first suggested valid move succeeds and updates state cleanly
      const first = moves[0];
      const res = executeSwap(state, first.from, first.to, { rng });
      expect(res.valid).toBe(true);
      expect(res.phases.length).toBeGreaterThan(0);
      expect(res.state.movesLeft).toBe(level.moves - 1);
    });
  }
});
