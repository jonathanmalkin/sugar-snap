export type CandyColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export const ALL_CANDY_COLORS: readonly CandyColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
] as const;

export type SpecialType = 'none' | 'striped-h' | 'striped-v' | 'wrapped' | 'color-bomb';

export type IngredientType = 'cherry' | 'hazelnut';

export type BoosterType = 'hammer' | 'free-switch' | 'shuffle';

export interface GridPos {
  row: number;
  col: number;
}

export interface Candy {
  id: number;
  color: CandyColor | 'none'; // 'none' for color-bomb or ingredient
  special: SpecialType;
  ingredient?: IngredientType;
}

export interface Cell {
  row: number;
  col: number;
  playable: boolean;
  jelly: 0 | 1 | 2;
  frosting: 0 | 1 | 2 | 3;
  locked: boolean;
  chocolate: boolean;
  isExit: boolean;
  candy: Candy | null;
}

export type ObjectiveKind = 'score' | 'jelly' | 'ingredients' | 'order';

export interface ObjectiveTarget {
  id: string;
  kind: ObjectiveKind;
  label: string;
  color?: CandyColor;
  special?: SpecialType;
  ingredient?: IngredientType;
  target: number;
}

export interface ObjectiveProgress extends ObjectiveTarget {
  current: number;
  completed: boolean;
}

export interface IngredientSpawnRule {
  type: IngredientType;
  count: number;
  maxOnBoard: number;
  spawnCols: number[];
}

export interface LevelDef {
  id: number; // 1..25
  chapterId: number; // 1..5
  name: string;
  subtitle: string;
  rows: number;
  cols: number;
  colors: CandyColor[];
  moves: number;
  starThresholds: [number, number, number];
  objectives: ObjectiveTarget[];
  /**
   * ASCII layout grid (length === rows, each string length === cols).
   *   '.' = playable cell
   *   '#' = unplayable cutout (hole)
   *   'j' = playable cell with 1-layer jelly
   *   'J' = playable cell with 2-layer jelly
   *   '1' = 1-layer frosting blocker (no candy inside)
   *   '2' = 2-layer frosting blocker
   *   '3' = 3-layer frosting blocker
   *   'L' = licorice locked candy cell
   *   'C' = chocolate blocker (no candy inside)
   *   'E' = playable cell marked as ingredient exit chute
   *   'e' = 1-layer jelly cell marked as ingredient exit chute
   */
  layout: string[];
  ingredientSpawns?: IngredientSpawnRule[];
  tutorialHint?: string;
}

export interface ChapterDef {
  id: number;
  name: string;
  tagline: string;
  accentColor: string;
  bgFrom: string;
  bgTo: string;
  trayTint: string;
  levelIds: number[];
}

export type PraiseWord = 'Snappy!' | 'Juicy!' | 'Yummy!' | 'Spectacular!' | 'Sugar Snap!';

export type AnimationEvent =
  | { type: 'swap'; from: GridPos; to: GridPos; valid: boolean }
  | { type: 'match'; cells: GridPos[]; color: CandyColor | 'none'; cascade: number; points: number }
  | { type: 'special-spawn'; pos: GridPos; candy: Candy }
  | {
      type: 'laser';
      origin: GridPos;
      orientation: 'h' | 'v';
      color: CandyColor | 'none';
      affected: GridPos[];
      width?: 1 | 3;
    }
  | {
      type: 'wrapped-boom';
      center: GridPos;
      radius: 1 | 2;
      stage: 1 | 2;
      color: CandyColor | 'none';
      affected: GridPos[];
    }
  | {
      type: 'lightning';
      origin: GridPos;
      targets: GridPos[];
      color: CandyColor | 'none';
      convertTo?: 'striped' | 'wrapped';
    }
  | { type: 'board-wipe'; origin: GridPos; affected: GridPos[] }
  | { type: 'blocker-hit'; pos: GridPos; blocker: 'frosting' | 'lock' | 'chocolate'; remaining: number }
  | { type: 'jelly-clear'; pos: GridPos; remaining: 0 | 1 }
  | { type: 'chocolate-spread'; from: GridPos; to: GridPos }
  | { type: 'ingredient-collect'; pos: GridPos; ingredient: IngredientType; candyId: number }
  | {
      type: 'gravity';
      moves: Array<{
        candyId: number;
        from: GridPos;
        to: GridPos;
        isNew: boolean;
        candy: Candy;
      }>;
    }
  | { type: 'shuffle'; mappings: Array<{ candyId: number; from: GridPos; to: GridPos }> }
  | { type: 'callout'; text: PraiseWord; pos?: GridPos; cascade: number }
  | { type: 'booster-hammer'; pos: GridPos }
  | { type: 'sugar-crush-comet'; to: GridPos; candy: Candy }
  | { type: 'score-popup'; pos: GridPos; points: number; color: CandyColor | 'none' };

export type PhaseKind =
  | 'swap'
  | 'clear'
  | 'combo'
  | 'wrapped-second'
  | 'gravity'
  | 'chocolate'
  | 'shuffle'
  | 'sugar-crush';

export interface ResolutionPhase {
  kind: PhaseKind;
  events: AnimationEvent[];
  gridAfter: Cell[][];
  scoreAfter: number;
  objectivesAfter: ObjectiveProgress[];
}

export interface GameState {
  level: LevelDef;
  grid: Cell[][];
  score: number;
  movesLeft: number;
  objectives: ObjectiveProgress[];
  status: 'playing' | 'sugar-crush' | 'won' | 'lost';
  nextCandyId: number;
  ingredientsRemainingToSpawn: IngredientType[];
  chocolateClearedThisTurn: boolean;
  totalMovesMade: number;
  maxCascade: number;
  collectedOrders: Record<string, number>;
  collectedIngredients: Record<string, number>;
}

export interface StepResult {
  valid: boolean;
  state: GameState;
  phases: ResolutionPhase[];
  starsEarned: 0 | 1 | 2 | 3;
  didShuffle: boolean;
}

export interface ValidMove {
  from: GridPos;
  to: GridPos;
  priority: number;
}

export interface MatchGroup {
  cells: GridPos[];
  color: CandyColor;
  shape: 'line3' | 'line4' | 'line5' | 'lt';
  spawnSpecial: SpecialType;
  spawnPos: GridPos;
}
