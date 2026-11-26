import type { PraiseWord, SpecialType } from '../engine/types';

export interface SoundSettings {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  sfxVolume: number; // 0..1
  musicVolume: number; // 0..1
}

export interface ISoundEngine {
  unlock(): void;
  updateSettings(settings: SoundSettings): void;
  playSelect(): void;
  playSwap(): void;
  playInvalidSwap(): void;
  playMatch(cascade: number, count: number): void;
  playLand(intensity?: number): void;
  playSpecialSpawn(special: SpecialType): void;
  playStripedBlast(mega?: boolean): void;
  playWrappedBlast(stage: 1 | 2, mega?: boolean): void;
  playColorBombZap(stepIndex?: number): void;
  playSeekerLaunch(): void;
  playBoardWipe(): void;
  playFrostingCrunch(): void;
  playJellyClear(): void;
  playLockBreak(): void;
  playChocolateSpread(): void;
  playIngredientCollect(): void;
  playCallout(word: PraiseWord): void;
  playShuffle(): void;
  playBooster(): void;
  playStar(starNumber: 1 | 2 | 3): void;
  playVictory(): void;
  playDefeat(): void;
  startMusic(): void;
  stopMusic(): void;
  dispose(): void;
}
