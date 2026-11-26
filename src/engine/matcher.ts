import type { CandyColor, Cell, GridPos, MatchGroup, SpecialType } from './types';

/** The colour a cell contributes to a match, or null if it cannot match. Locked candies can match. */
export function matchableColor(cell: Cell | null | undefined): CandyColor | null {
  if (!cell || !cell.playable || cell.frosting > 0 || cell.chocolate || !cell.candy) return null;
  const candy = cell.candy;
  if (candy.ingredient || candy.special === 'color-bomb' || candy.color === 'none') return null;
  return candy.color;
}

interface Run {
  cells: GridPos[];
  axis: 'h' | 'v';
  color: CandyColor;
}

const key = (p: GridPos) => `${p.row},${p.col}`;

function findRuns(grid: Cell[][]): Run[] {
  const runs: Run[] = [];
  const rows = grid.length;
  const cols = rows ? Math.max(...grid.map((r) => r.length)) : 0;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const color = matchableColor(grid[r][c]);
      if (!color) {
        c++;
        continue;
      }
      let e = c + 1;
      while (e < cols && matchableColor(grid[r][e]) === color) e++;
      if (e - c >= 3) runs.push({ axis: 'h', color, cells: Array.from({ length: e - c }, (_, i) => ({ row: r, col: c + i })) });
      c = e;
    }
  }
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      const color = matchableColor(grid[r]?.[c]);
      if (!color) {
        r++;
        continue;
      }
      let e = r + 1;
      while (e < rows && matchableColor(grid[e]?.[c]) === color) e++;
      if (e - r >= 3) runs.push({ axis: 'v', color, cells: Array.from({ length: e - r }, (_, i) => ({ row: r + i, col: c })) });
      r = e;
    }
  }
  return runs;
}

export function findMatches(grid: Cell[][], swappedPositions?: [GridPos, GridPos]): MatchGroup[] {
  const runs = findRuns(grid);
  if (!runs.length) return [];

  // Union runs that share a cell (always the same colour, since a cell has one colour).
  const parent = runs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byCell = new Map<string, number[]>();
  runs.forEach((run, i) =>
    run.cells.forEach((p) => {
      const list = byCell.get(key(p)) ?? [];
      list.push(i);
      byCell.set(key(p), list);
    }),
  );
  for (const list of byCell.values()) for (let i = 1; i < list.length; i++) parent[find(list[i])] = find(list[0]);

  const groupsByRoot = new Map<number, Run[]>();
  runs.forEach((run, i) => {
    const root = find(i);
    groupsByRoot.set(root, [...(groupsByRoot.get(root) ?? []), run]);
  });

  const groups: MatchGroup[] = [];
  for (const groupRuns of groupsByRoot.values()) {
    const cellMap = new Map<string, GridPos>();
    groupRuns.forEach((run) => run.cells.forEach((p) => cellMap.set(key(p), p)));
    const cells = [...cellMap.values()].sort((a, b) => a.row - b.row || a.col - b.col);
    const hasH = groupRuns.some((r) => r.axis === 'h');
    const hasV = groupRuns.some((r) => r.axis === 'v');
    const longest = groupRuns.reduce((best, r) => (r.cells.length > best.cells.length ? r : best));
    const hKeys = new Set(groupRuns.filter((r) => r.axis === 'h').flatMap((r) => r.cells.map(key)));
    const intersection = groupRuns
      .filter((r) => r.axis === 'v')
      .flatMap((r) => r.cells)
      .find((p) => hKeys.has(key(p)));

    const swappedInGroup = swappedPositions?.find((p) => cellMap.has(key(p)));

    let shape: MatchGroup['shape'];
    let spawnSpecial: SpecialType;
    if (longest.cells.length >= 5) {
      shape = 'line5';
      spawnSpecial = 'color-bomb';
    } else if (hasH && hasV) {
      shape = 'lt';
      spawnSpecial = 'wrapped';
    } else if (longest.cells.length === 4) {
      shape = 'line4';
      if (swappedInGroup && swappedPositions) {
        const [from, to] = swappedPositions;
        spawnSpecial = from.row === to.row ? 'striped-h' : 'striped-v';
      } else spawnSpecial = longest.axis === 'h' ? 'striped-h' : 'striped-v';
    } else {
      shape = 'line3';
      spawnSpecial = 'none';
    }

    const middle = longest.cells[Math.floor(longest.cells.length / 2)];
    const spawnPos = swappedInGroup ?? (shape === 'lt' && intersection ? intersection : middle);
    groups.push({ cells, color: longest.color, shape, spawnSpecial, spawnPos: { ...spawnPos } });
  }
  return groups.sort((a, b) => a.cells[0].row - b.cells[0].row || a.cells[0].col - b.cells[0].col);
}

/** True if the candy at pos sits in a straight run of three or more. */
export function formsMatchAt(grid: Cell[][], pos: GridPos): boolean {
  const color = matchableColor(grid[pos.row]?.[pos.col]);
  if (!color) return false;
  const count = (dr: number, dc: number) => {
    let n = 0;
    let r = pos.row + dr;
    let c = pos.col + dc;
    while (matchableColor(grid[r]?.[c]) === color) {
      n++;
      r += dr;
      c += dc;
    }
    return n;
  };
  return 1 + count(0, -1) + count(0, 1) >= 3 || 1 + count(-1, 0) + count(1, 0) >= 3;
}
