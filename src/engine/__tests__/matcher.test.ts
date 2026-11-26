import { describe, expect, it } from 'vitest';
import { canSwap, findMatches, findValidMoves, isAdjacent, parseBoardSpec } from '../index';
import type { GridPos } from '../index';

const p = (row: number, col: number): GridPos => ({ row, col });
const keys = (cells: GridPos[]) => cells.map((c) => `${c.row},${c.col}`).sort();

describe('findMatches — shapes', () => {
  it('finds a horizontal three', () => {
    const groups = findMatches(parseBoardSpec(['r r r g', 'g b g b', 'b g b g']));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ shape: 'line3', color: 'red', spawnSpecial: 'none', spawnPos: p(0, 1) });
    expect(keys(groups[0].cells)).toEqual(['0,0', '0,1', '0,2']);
  });

  it('finds a vertical three', () => {
    const groups = findMatches(parseBoardSpec(['r g b', 'r b g', 'r g b']));
    expect(groups).toHaveLength(1);
    expect(groups[0].shape).toBe('line3');
    expect(keys(groups[0].cells)).toEqual(['0,0', '1,0', '2,0']);
  });

  it('a horizontal four with no swap gives a horizontal stripe at the middle', () => {
    const [g] = findMatches(parseBoardSpec(['r r r r', 'g b g b', 'b g b g']));
    expect(g).toMatchObject({ shape: 'line4', spawnSpecial: 'striped-h', spawnPos: p(0, 2) });
  });

  it('a vertical four with no swap gives a vertical stripe', () => {
    const [g] = findMatches(parseBoardSpec(['r g', 'r b', 'r g', 'r b']));
    expect(g).toMatchObject({ shape: 'line4', spawnSpecial: 'striped-v' });
  });

  it('a four made by a vertical swap gives striped-v at the swapped cell', () => {
    const [g] = findMatches(parseBoardSpec(['r r r r g', 'g b g b b', 'b g b g g']), [p(1, 1), p(0, 1)]);
    expect(g).toMatchObject({ shape: 'line4', spawnSpecial: 'striped-v', spawnPos: p(0, 1) });
  });

  it('a four made by a horizontal swap gives striped-h at the swapped cell', () => {
    const [g] = findMatches(parseBoardSpec(['r r r r g', 'g b g b b', 'b g b g g']), [p(0, 4), p(0, 3)]);
    expect(g).toMatchObject({ shape: 'line4', spawnSpecial: 'striped-h', spawnPos: p(0, 3) });
  });

  it('a straight five gives a colour bomb', () => {
    const [g] = findMatches(parseBoardSpec(['r r r r r', 'g b g b g', 'b g b g b']));
    expect(g).toMatchObject({ shape: 'line5', spawnSpecial: 'color-bomb', spawnPos: p(0, 2) });
    expect(g.cells).toHaveLength(5);
  });

  it('merges an L into one wrapped group at the corner', () => {
    const groups = findMatches(parseBoardSpec(['r g b', 'r b g', 'r r r']));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ shape: 'lt', spawnSpecial: 'wrapped', spawnPos: p(2, 0) });
    expect(groups[0].cells).toHaveLength(5);
  });

  it('merges a T into one wrapped group at the intersection', () => {
    const [g] = findMatches(parseBoardSpec(['r r r', 'g r b', 'b r g']));
    expect(g).toMatchObject({ shape: 'lt', spawnSpecial: 'wrapped', spawnPos: p(0, 1) });
    expect(g.cells).toHaveLength(5);
  });

  it('a five crossing a three still makes a colour bomb', () => {
    const [g] = findMatches(parseBoardSpec(['r r r r r', 'g b r b g', 'b g r g b']));
    expect(g.shape).toBe('line5');
    expect(g.cells).toHaveLength(7);
  });

  it('keeps separate runs as separate groups', () => {
    const groups = findMatches(parseBoardSpec(['r r r', 'g b g', 'b b b']));
    expect(groups.map((g) => g.color)).toEqual(['red', 'blue']);
  });

  it('locked candies match with same-colour neighbours', () => {
    const [g] = findMatches(parseBoardSpec(['r:L r r g']));
    expect(g.cells).toHaveLength(3);
  });

  it('holes, frosting, chocolate, bombs and ingredients break runs', () => {
    expect(findMatches(parseBoardSpec(['r r 1 r r']))).toEqual([]);
    expect(findMatches(parseBoardSpec(['r r # r r']))).toEqual([]);
    expect(findMatches(parseBoardSpec(['r X r r g']))).toEqual([]);
    expect(findMatches(parseBoardSpec(['B B B']))).toEqual([]);
    expect(findMatches(parseBoardSpec(['I I I']))).toEqual([]);
  });

  it('specials of a colour match like regular candies', () => {
    const [g] = findMatches(parseBoardSpec(['rh r rw g']));
    expect(g.cells).toHaveLength(3);
  });
});

describe('canSwap', () => {
  const grid = () => parseBoardSpec(['r g r', 'g r g', 'b b g']);

  it('allows a swap that forms a match', () => {
    expect(canSwap(grid(), p(0, 1), p(1, 1))).toBe(true);
  });

  it('rejects a swap with no match, non-adjacent swaps and out-of-board swaps', () => {
    expect(canSwap(grid(), p(0, 0), p(1, 0))).toBe(false);
    expect(canSwap(grid(), p(0, 0), p(2, 2))).toBe(false);
    expect(canSwap(grid(), p(0, 2), p(0, 3))).toBe(false);
  });

  it('rejects locked, frosting and chocolate cells', () => {
    expect(canSwap(parseBoardSpec(['r g r', 'g r:L g', 'b b g']), p(0, 1), p(1, 1))).toBe(false);
    expect(canSwap(parseBoardSpec(['r 1 r', 'g r g']), p(0, 1), p(1, 1))).toBe(false);
    expect(canSwap(parseBoardSpec(['r X r', 'g r g']), p(0, 1), p(1, 1))).toBe(false);
  });

  it('allows any two specials and a bomb with any candy, but never a bomb with an ingredient', () => {
    expect(canSwap(parseBoardSpec(['rh gv']), p(0, 0), p(0, 1))).toBe(true);
    expect(canSwap(parseBoardSpec(['rw gw']), p(0, 0), p(0, 1))).toBe(true);
    expect(canSwap(parseBoardSpec(['B g']), p(0, 0), p(0, 1))).toBe(true);
    expect(canSwap(parseBoardSpec(['B B']), p(0, 0), p(0, 1))).toBe(true);
    expect(canSwap(parseBoardSpec(['B I']), p(0, 0), p(0, 1))).toBe(false);
    expect(canSwap(parseBoardSpec(['I N']), p(0, 0), p(0, 1))).toBe(false);
  });

  it('does not mutate the grid it checks', () => {
    const g = grid();
    const before = JSON.stringify(g);
    canSwap(g, p(0, 1), p(1, 1));
    expect(JSON.stringify(g)).toBe(before);
  });

  it('isAdjacent is orthogonal only', () => {
    expect(isAdjacent(p(1, 1), p(1, 2))).toBe(true);
    expect(isAdjacent(p(1, 1), p(2, 1))).toBe(true);
    expect(isAdjacent(p(1, 1), p(2, 2))).toBe(false);
    expect(isAdjacent(p(1, 1), p(1, 1))).toBe(false);
  });
});

describe('findValidMoves', () => {
  it('ranks a five above a three', () => {
    const moves = findValidMoves(parseBoardSpec(['r r g r r', 'g b r b g', 'b g b g b']));
    expect(moves[0]).toMatchObject({ from: p(0, 2), to: p(1, 2), priority: 50 });
  });

  it('ranks special combos at 100, then L/T 40, four 30, three 10', () => {
    expect(findValidMoves(parseBoardSpec(['rh gv b', 'b g r']))[0].priority).toBe(100);
    expect(findValidMoves(parseBoardSpec(['r g b', 'r b g', 'g r r', 'r b g']))[0].priority).toBe(40);
    expect(findValidMoves(parseBoardSpec(['r r g r', 'g b r b']))[0].priority).toBe(30);
    expect(findValidMoves(parseBoardSpec(['r g r', 'g r g']))[0].priority).toBe(10);
  });

  it('is sorted by priority and every move passes canSwap', () => {
    const grid = parseBoardSpec(['r r g r r', 'g b r b g', 'b g b g b', 'rh b g r g']);
    const moves = findValidMoves(grid);
    expect(moves.length).toBeGreaterThan(1);
    for (let i = 1; i < moves.length; i++) expect(moves[i - 1].priority).toBeGreaterThanOrEqual(moves[i].priority);
    for (const m of moves) expect(canSwap(grid, m.from, m.to)).toBe(true);
  });

  it('returns nothing on a deadlocked diagonal board', () => {
    expect(findValidMoves(parseBoardSpec(['r g b r', 'g b r g', 'b r g b', 'r g b r']))).toEqual([]);
  });
});
