import type { BoosterType, Cell } from '../engine/types';

export interface LevelProgress {
  completed: boolean;
  stars: 0 | 1 | 2 | 3;
  bestScore: number;
}

export interface UserSettings {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  sfxVolume: number;
  musicVolume: number;
  colorblindMode: boolean;
  reducedMotion: boolean;
}

export interface ZenSaveState {
  grid: Cell[][];
  score: number;
  maxCascade: number;
  totalMovesMade: number;
  nextCandyId: number;
}

export interface PlayerSave {
  highestUnlockedLevel: number;
  levels: Record<number, LevelProgress>;
  boosters: Record<BoosterType, number>;
  totalStarsClaimedForBoosters: number;
  winStreak: number;
  zenBestScore: number;
  zenBestCascade: number;
  zenState: ZenSaveState | null;
  settings: UserSettings;
}
