import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createSoundEngine } from './audio';
import { nextMusicTrack, resolveAutoTrack, type ISoundEngine, type MusicTrackId } from './audio/soundTypes';
import type { BoosterType } from './engine/types';
import { GameScreen, type LevelWinRecord } from './components/GameScreen';
import { SagaMap } from './components/SagaMap';
import { SettingsModal } from './components/SettingsModal';
import { LEVELS, ZEN_LEVEL } from './levels';
import {
  STORAGE_KEY,
  clearZenSession,
  consumeBooster,
  loadSave,
  mutateSave,
  recordLevelCompletion,
  resetPlayerSave,
  resetWinStreak,
  saveZenSession,
  savePlayerData,
  updateUserSettings,
} from './state/storage';
import type { PlayerSave, UserSettings, ZenSaveState } from './state/storageTypes';

type Screen = { name: 'map' } | { name: 'play'; levelId: number; showIntro: boolean } | { name: 'zen' };

/* One sound engine for the life of the page (survives StrictMode remounts). */
let soundSingleton: ISoundEngine | null = null;
function getSound(): ISoundEngine {
  if (!soundSingleton) soundSingleton = createSoundEngine();
  return soundSingleton;
}

const MAX_LEVEL = LEVELS.reduce((m, l) => Math.max(m, l.id), 1);

export function App(): ReactElement {
  const sound = getSound();
  const [save, setSave] = useState<PlayerSave>(() => loadSave());
  const saveRef = useRef(save);
  const [screen, setScreen] = useState<Screen>({ name: 'map' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  /** Mid-level track override while in Auto Rotate mode; clears when advancing to the next level. */
  const [sessionTrackOverride, setSessionTrackOverride] = useState<MusicTrackId | null>(null);

  const commit = useCallback((next: PlayerSave) => {
    saveRef.current = next;
    setSave(next);
    savePlayerData(next);
  }, []);

  // Keep open tabs synchronized if another tab updates Sugar Snap progress.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      const fresh = loadSave();
      saveRef.current = fresh;
      setSave(fresh);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const { settings } = save;

  /* ---------- audio ---------- */

  // iOS only lets audio start inside a user gesture: unlock on every first-touch.
  useEffect(() => {
    const unlock = () => {
      sound.unlock();
      setAudioUnlocked(true);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [sound]);

  useEffect(() => {
    sound.updateSettings({
      sfxEnabled: settings.sfxEnabled,
      musicEnabled: settings.musicEnabled,
      sfxVolume: settings.sfxVolume,
      musicVolume: settings.musicVolume,
    });
  }, [sound, settings.sfxEnabled, settings.musicEnabled, settings.sfxVolume, settings.musicVolume]);

  const activeMusicTrack: MusicTrackId =
    sessionTrackOverride ?? (settings.musicTrack === 'auto' ? resolveAutoTrack(screen) : settings.musicTrack);

  useEffect(() => {
    sound.setMusicTrack(activeMusicTrack);
  }, [sound, activeMusicTrack]);

  useEffect(() => {
    if (audioUnlocked && settings.musicEnabled) sound.startMusic();
    else sound.stopMusic();
  }, [sound, audioUnlocked, settings.musicEnabled]);

  /* ---------- page-level iPad hygiene ---------- */

  useEffect(() => {
    document.documentElement.dataset.motion = settings.reducedMotion ? 'reduced' : 'full';
  }, [settings.reducedMotion]);

  useEffect(() => {
    // Safari ignores user-scalable=no for pinch; block gesture zoom explicitly.
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', block, { passive: false });
    document.addEventListener('gesturechange', block, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
    };
  }, []);

  /* ---------- navigation ---------- */

  /** Map picks show the Intro sheet; Victory's Next Level passes `false` to flow straight in. */
  const playLevel = useCallback((levelId: number, showIntro = true) => {
    const target = Math.max(1, Math.min(levelId, MAX_LEVEL));
    setSessionTrackOverride(null);
    setScreen({ name: 'play', levelId: target, showIntro });
  }, []);

  const playZen = useCallback(() => {
    setSessionTrackOverride(null);
    setScreen({ name: 'zen' });
  }, []);

  const exitToMap = useCallback(() => {
    setSessionTrackOverride(null);
    setScreen({ name: 'map' });
  }, []);

  /* ---------- save mutations ---------- */

  const handleBoosterConsumed = useCallback((booster: BoosterType) => {
    const { save: next } = mutateSave((latest) => ({ save: consumeBooster(latest, booster), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

  const handleLevelWon = useCallback((levelId: number, score: number, stars: 1 | 2 | 3): LevelWinRecord => {
    const { save: next, result } = mutateSave((latest) => {
      const prevBest = latest.levels[levelId]?.bestScore ?? 0;
      const { save: updated, awardedBoosters } = recordLevelCompletion(latest, levelId, score, stars);
      return {
        save: updated,
        result: { awardedBoosters, bestScore: Math.max(prevBest, score), isNewBest: score > prevBest },
      };
    });
    saveRef.current = next;
    setSave(next);
    return result;
  }, []);

  const handleStreakReset = useCallback(() => {
    if (saveRef.current.winStreak <= 0 && loadSave().winStreak <= 0) return;
    const { save: next } = mutateSave((latest) => ({ save: resetWinStreak(latest), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

  const handleZenSnapshot = useCallback((zen: ZenSaveState) => {
    const { save: next } = mutateSave((latest) => ({ save: saveZenSession(latest, zen), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

  const handleZenReset = useCallback(() => {
    const { save: next } = mutateSave((latest) => ({ save: clearZenSession(latest), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

  const handleSettingsChange = useCallback((partial: Partial<UserSettings>) => {
    if (partial.musicTrack !== undefined) setSessionTrackOverride(null);
    const { save: next } = mutateSave((latest) => ({ save: updateUserSettings(latest, partial), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

  const handleCycleMusicTrack = useCallback(() => {
    sound.unlock();
    setAudioUnlocked(true);
    const cur = saveRef.current.settings;
    if (!cur.musicEnabled) {
      const { save: next } = mutateSave((latest) => ({
        save: updateUserSettings(latest, { musicEnabled: true }),
        result: undefined,
      }));
      saveRef.current = next;
      setSave(next);
      return;
    }
    const nextTrack = nextMusicTrack(activeMusicTrack);
    if (cur.musicTrack === 'auto') {
      setSessionTrackOverride(nextTrack);
    } else {
      setSessionTrackOverride(null);
      const { save: next } = mutateSave((latest) => ({
        save: updateUserSettings(latest, { musicTrack: nextTrack }),
        result: undefined,
      }));
      saveRef.current = next;
      setSave(next);
    }
  }, [sound, activeMusicTrack]);

  const handleReset = useCallback(() => {
    commit(resetPlayerSave());
    setSettingsOpen(false);
    setScreen({ name: 'map' });
  }, [commit]);

  return (
    <div className="app">
      {screen.name === 'map' ? (
        <SagaMap
          save={save}
          reducedMotion={settings.reducedMotion}
          onPlayLevel={playLevel}
          onPlayZen={playZen}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <GameScreen
          key={screen.name === 'zen' ? 'zen' : `level-${screen.levelId}`}
          mode={screen.name === 'zen' ? 'zen' : 'saga'}
          levelId={screen.name === 'zen' ? ZEN_LEVEL.id : screen.levelId}
          save={save}
          sound={sound}
          showIntro={screen.name === 'play' && screen.showIntro}
          overlayOpen={settingsOpen}
          onExitToMap={exitToMap}
          onOpenSettings={() => setSettingsOpen(true)}
          onPlayLevel={playLevel}
          onBoosterConsumed={handleBoosterConsumed}
          onLevelWon={handleLevelWon}
          onUnlockAudio={() => setAudioUnlocked(true)}
          onStreakReset={handleStreakReset}
          onZenSnapshot={handleZenSnapshot}
          onZenReset={handleZenReset}
          activeMusicTrack={activeMusicTrack}
          onCycleMusicTrack={handleCycleMusicTrack}
        />
      )}

      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          onChange={handleSettingsChange}
          onReset={handleReset}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}

export default App;
