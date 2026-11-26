import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createSoundEngine } from './audio';
import type { ISoundEngine } from './audio/soundTypes';
import type { BoosterType } from './engine/types';
import { GameScreen, type LevelWinRecord } from './components/GameScreen';
import { SagaMap } from './components/SagaMap';
import { SettingsModal } from './components/SettingsModal';
import { LEVELS } from './levels';
import {
  STORAGE_KEY,
  consumeBooster,
  loadSave,
  mutateSave,
  recordLevelCompletion,
  resetPlayerSave,
  savePlayerData,
  updateUserSettings,
} from './state/storage';
import type { PlayerSave, UserSettings } from './state/storageTypes';

type Screen = { name: 'map' } | { name: 'play'; levelId: number; showIntro: boolean };

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

  const playLevel = useCallback((levelId: number) => {
    const target = Math.max(1, Math.min(levelId, saveRef.current.highestUnlockedLevel, MAX_LEVEL));
    setScreen({ name: 'play', levelId: target, showIntro: true });
  }, []);

  const exitToMap = useCallback(() => setScreen({ name: 'map' }), []);

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

  const handleSettingsChange = useCallback((partial: Partial<UserSettings>) => {
    const { save: next } = mutateSave((latest) => ({ save: updateUserSettings(latest, partial), result: undefined }));
    saveRef.current = next;
    setSave(next);
  }, []);

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
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <GameScreen
          key={screen.levelId}
          levelId={screen.levelId}
          save={save}
          sound={sound}
          showIntro={screen.showIntro}
          overlayOpen={settingsOpen}
          onExitToMap={exitToMap}
          onOpenSettings={() => setSettingsOpen(true)}
          onPlayLevel={playLevel}
          onBoosterConsumed={handleBoosterConsumed}
          onLevelWon={handleLevelWon}
          onUnlockAudio={() => setAudioUnlocked(true)}
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
