import type { PraiseWord, SpecialType } from '../engine/types';

export type MusicTrackId = 'funk' | 'bossa' | 'lounge' | 'lofi';
export type MusicSelection = 'auto' | MusicTrackId;

export interface MusicTrackMeta {
  id: MusicTrackId;
  label: string;
  subtitle: string;
  title: string;
  file: string;
}

export const MUSIC_TRACKS: readonly MusicTrackMeta[] = [
  { id: 'funk', label: 'Funk Groove', subtitle: 'Upbeat live band funk', title: 'Funk Game Loop', file: 'funk.mp3' },
  { id: 'bossa', label: 'Bossa Nova', subtitle: 'Sunny acoustic piano & bass', title: 'Bossa Antigua', file: 'bossa.mp3' },
  { id: 'lounge', label: 'Jazz Lounge', subtitle: 'Warm studio vibraphone', title: 'Vibing Over Venus', file: 'lounge.mp3' },
  { id: 'lofi', label: 'Lo-Fi Chill', subtitle: 'Cozy late-night chillhop', title: 'Late Night Radio', file: 'lofi.mp3' },
] as const;

export function getMusicTrackMeta(id: MusicTrackId): MusicTrackMeta {
  return MUSIC_TRACKS.find((t) => t.id === id) ?? MUSIC_TRACKS[0];
}

export function nextMusicTrack(current: MusicTrackId): MusicTrackId {
  const idx = MUSIC_TRACKS.findIndex((t) => t.id === current);
  return MUSIC_TRACKS[(idx + 1) % MUSIC_TRACKS.length].id;
}

export function resolveAutoTrack(screen: { name: 'map' } | { name: 'zen' } | { name: 'play'; levelId: number }): MusicTrackId {
  if (screen.name === 'zen') return 'lofi';
  if (screen.name === 'map') return 'bossa';
  return MUSIC_TRACKS[(Math.max(1, screen.levelId) - 1) % MUSIC_TRACKS.length].id;
}

export interface SoundSettings {
  sfxEnabled: boolean;
  musicEnabled: boolean;
  sfxVolume: number; // 0..1
  musicVolume: number; // 0..1
}

export interface ISoundEngine {
  unlock(): void;
  updateSettings(settings: SoundSettings): void;
  setMusicTrack(track: MusicTrackId): void;
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
