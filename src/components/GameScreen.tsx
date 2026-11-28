import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { getMusicTrackMeta, type ISoundEngine, type MusicTrackId } from '../audio/soundTypes';
import { applyBakersGift, createGameState, restoreZenState } from '../engine';
import type { BoosterType, GameState, ObjectiveProgress } from '../engine/types';
import { getChapterById, getLevelById, LEVELS, ZEN_CHAPTER, ZEN_LEVEL } from '../levels';
import { GameController, type GameControllerOptions } from '../renderer';
import type { PlayerSave, ZenSaveState } from '../state/storageTypes';
import { BoosterDock } from './BoosterDock';
import { CandyIcon } from './CandyIcon';
import { HudPanel, TutorialTip } from './HudPanel';
import { LevelIntroSheet, OutOfMovesModal, VictoryModal } from './LevelModals';

/** Mirrors the `onStateChange` payload of `GameControllerOptions`. */
interface Snapshot {
  score: number;
  movesLeft: number;
  objectives: ObjectiveProgress[];
  status: GameState['status'];
  stars: 0 | 1 | 2 | 3;
  activeBooster: BoosterType | null;
  isAnimating: boolean;
}

/** Mirrors the `onLevelEnd` payload of `GameControllerOptions`. */
interface ControllerEnd {
  won: boolean;
  score: number;
  stars: 0 | 1 | 2 | 3;
  maxCascade: number;
}

export interface LevelWinRecord {
  awardedBoosters: BoosterType[];
  bestScore: number;
  isNewBest: boolean;
}

export type GameMode = 'saga' | 'zen';

export interface GameScreenProps {
  /** 'saga' plays `levelId`; 'zen' plays the endless ZEN_LEVEL board. */
  mode: GameMode;
  levelId: number;
  save: PlayerSave;
  sound: ISoundEngine;
  showIntro: boolean;
  /** True when Settings (owned by App) is open on top of the game. */
  overlayOpen: boolean;
  onExitToMap: () => void;
  onOpenSettings: () => void;
  /** `showIntro: false` flows straight into the board (1-tap Next Level). */
  onPlayLevel: (levelId: number, showIntro?: boolean) => void;
  onBoosterConsumed: (booster: BoosterType) => void;
  onLevelWon: (levelId: number, score: number, stars: 1 | 2 | 3) => LevelWinRecord;
  onUnlockAudio: () => void;
  /** Saga loss or retry: the win streak ends. */
  onStreakReset: () => void;
  /** Zen: every settled move auto-saves. */
  onZenSnapshot: (zen: ZenSaveState) => void;
  /** Zen: New Board clears the saved session. */
  onZenReset: () => void;
  /** Currently active studio music track for this level. */
  activeMusicTrack: MusicTrackId;
  /** 1-tap mid-level track switcher. */
  onCycleMusicTrack: () => void;
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'intro' }
  | { kind: 'won'; score: number; stars: 1 | 2 | 3; record: LevelWinRecord }
  | { kind: 'lost'; score: number };

function snapshotFrom(state: GameState): Snapshot {
  return {
    score: state.score,
    movesLeft: state.movesLeft,
    objectives: state.objectives,
    status: state.status,
    stars: 0,
    activeBooster: null,
    isAnimating: false,
  };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (
    a.score !== b.score ||
    a.movesLeft !== b.movesLeft ||
    a.status !== b.status ||
    a.stars !== b.stars ||
    a.activeBooster !== b.activeBooster ||
    a.isAnimating !== b.isAnimating ||
    a.objectives.length !== b.objectives.length
  ) {
    return false;
  }
  for (let i = 0; i < a.objectives.length; i++) {
    const x = a.objectives[i];
    const y = b.objectives[i];
    if (x.id !== y.id || x.current !== y.current || x.completed !== y.completed) return false;
  }
  return true;
}

export function GameScreen(props: GameScreenProps): ReactElement {
  const {
    mode,
    levelId,
    save,
    sound,
    showIntro,
    overlayOpen,
    onExitToMap,
    onOpenSettings,
    onPlayLevel,
    activeMusicTrack,
    onCycleMusicTrack,
  } = props;
  const trackMeta = getMusicTrackMeta(activeMusicTrack);
  const isZen = mode === 'zen';
  const level = useMemo(() => (isZen ? ZEN_LEVEL : getLevelById(levelId)), [isZen, levelId]);
  const chapter = useMemo(() => (isZen ? ZEN_CHAPTER : getChapterById(level.chapterId)), [isZen, level]);
  const { colorblindMode, reducedMotion } = save.settings;

  const stageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const endTimerRef = useRef<number | null>(null);
  const dealTimerRef = useRef<number | null>(null);
  /** Zen: true until New Board, so the first board resumes the saved session. */
  const zenResumeRef = useRef(true);

  const [runKey, setRunKey] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    score: 0,
    movesLeft: level.moves,
    objectives: level.objectives.map((o) => ({ ...o, current: 0, completed: false })),
    status: 'playing',
    stars: 0,
    activeBooster: null,
    isAnimating: false,
  }));
  const [modal, setModal] = useState<ModalState>(showIntro && !isZen ? { kind: 'intro' } : { kind: 'none' });
  const [activeBooster, setActiveBooster] = useState<BoosterType | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [giftStreak, setGiftStreak] = useState(0);
  const [zenCascade, setZenCascade] = useState(0);
  const [dealing, setDealing] = useState(false);

  // Latest props/handlers for controller callbacks (controller is created once per run).
  const latest = useRef(props);
  latest.current = props;
  const displayRef = useRef({ colorblindMode, reducedMotion });
  displayRef.current = { colorblindMode, reducedMotion };

  /* ---------- board fitting ---------- */

  const fitBoard = useCallback(() => {
    const stage = stageRef.current;
    const board = boardRef.current;
    if (!stage || !board) return;
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(stage);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availW = Math.max(0, rect.width - padX);
    const availH = Math.max(0, rect.height - padY);
    const aspect = level.cols / level.rows;
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    const nextW = `${Math.floor(w)}px`;
    const nextH = `${Math.floor(h)}px`;
    if (board.style.width !== nextW || board.style.height !== nextH) {
      board.style.width = nextW;
      board.style.height = nextH;
    }
    controllerRef.current?.resize();
  }, [level]);

  useLayoutEffect(() => {
    fitBoard();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fitBoard);
      return () => window.removeEventListener('resize', fitBoard);
    }
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitBoard);
    });
    ro.observe(stage);
    const onOrient = () => window.setTimeout(fitBoard, 250);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('orientationchange', onOrient);
    };
  }, [fitBoard]);

  /* ---------- controller lifecycle ---------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentSave = latest.current.save;

    let initialState: GameState;
    let gifted = 0;
    if (isZen) {
      const saved = zenResumeRef.current ? currentSave.zenState : null;
      initialState = saved ? restoreZenState(level, saved) : createGameState(level);
    } else {
      initialState = createGameState(level);
      const streak = currentSave.winStreak;
      if (streak >= 1) {
        const baked = applyBakersGift(initialState, streak);
        initialState = baked.state;
        if (baked.gifts.length > 0) gifted = streak;
      }
    }
    setSnapshot(snapshotFrom(initialState));
    setActiveBooster(null);
    setGiftStreak(gifted);
    setZenCascade(initialState.maxCascade);

    let recordedWin: { score: number; stars: 1 | 2 | 3; record: LevelWinRecord } | null = null;
    const ensureWinPersisted = (result: ControllerEnd): { score: number; stars: 1 | 2 | 3; record: LevelWinRecord } => {
      if (recordedWin) return recordedWin;
      const stars = Math.max(1, result.stars) as 1 | 2 | 3;
      const record = latest.current.onLevelWon(level.id, result.score, stars);
      recordedWin = { score: result.score, stars, record };
      return recordedWin;
    };
    let streakEnded = false;
    const endStreak = () => {
      if (streakEnded) return;
      streakEnded = true;
      latest.current.onStreakReset();
    };

    const options: GameControllerOptions = {
      canvas,
      initialState,
      chapter,
      sound,
      colorblindMode: displayRef.current.colorblindMode,
      reducedMotion: displayRef.current.reducedMotion,
      onStateChange: (next: Snapshot) => {
        setSnapshot((prev) =>
          sameSnapshot(prev, next) ? prev : { ...next, objectives: next.objectives.map((o) => ({ ...o })) }
        );
      },
      onBoosterConsumed: (booster: BoosterType) => {
        if (booster !== 'shuffle') setActiveBooster(null);
        latest.current.onBoosterConsumed(booster);
      },
      onLevelResolved: (result: ControllerEnd) => {
        if (isZen) return;
        if (result.won) ensureWinPersisted(result);
        else endStreak();
      },
      onLevelEnd: (result: ControllerEnd) => {
        // Endless Zen never ends: no Victory or Out-of-Moves.
        if (isZen) return;
        if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
        const delay = displayRef.current.reducedMotion ? 150 : 450;
        if (result.won) {
          const persisted = ensureWinPersisted(result);
          endTimerRef.current = window.setTimeout(() => {
            setModal({ kind: 'won', score: persisted.score, stars: persisted.stars, record: persisted.record });
          }, delay);
        } else {
          endStreak();
          endTimerRef.current = window.setTimeout(() => {
            sound.playDefeat();
            setModal((m) => (m.kind === 'won' ? m : { kind: 'lost', score: result.score }));
          }, delay);
        }
      },
    };
    if (isZen) {
      options.onZenSnapshot = (zen: ZenSaveState) => {
        setZenCascade((prev) => Math.max(prev, zen.maxCascade));
        latest.current.onZenSnapshot(zen);
      };
    }

    const controller = new GameController(options);
    controllerRef.current = controller;
    fitBoard();
    controller.start();

    return () => {
      if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // runKey restarts the level from scratch (Retry / Replay / New Board).
  }, [isZen, level, chapter, sound, runKey, fitBoard]);

  useEffect(() => {
    controllerRef.current?.setDisplayOptions({ colorblindMode, reducedMotion });
  }, [colorblindMode, reducedMotion]);

  useEffect(() => {
    controllerRef.current?.setInputPaused(overlayOpen || modal.kind !== 'none');
  }, [overlayOpen, modal.kind]);

  // Controller is the source of truth for booster selection once it reports one.
  useEffect(() => {
    setActiveBooster(snapshot.activeBooster);
  }, [snapshot.activeBooster]);

  useEffect(
    () => () => {
      if (dealTimerRef.current !== null) window.clearTimeout(dealTimerRef.current);
    },
    []
  );

  /* ---------- actions ---------- */

  /** Replay after a win keeps the streak alive. */
  const replay = useCallback(() => {
    setModal({ kind: 'none' });
    setRunKey((k) => k + 1);
  }, []);

  /** Retry (mid-level or after running out of moves) gently ends the streak. */
  const retry = useCallback(() => {
    latest.current.onStreakReset();
    setModal({ kind: 'none' });
    setRunKey((k) => k + 1);
  }, []);

  /** Zen: forget the saved session and deal a fresh board with a soft fade. */
  const newZenBoard = useCallback(() => {
    zenResumeRef.current = false;
    latest.current.onZenReset();
    setRunKey((k) => k + 1);
    if (displayRef.current.reducedMotion) return;
    setDealing(true);
    if (dealTimerRef.current !== null) window.clearTimeout(dealTimerRef.current);
    dealTimerRef.current = window.setTimeout(() => {
      dealTimerRef.current = null;
      setDealing(false);
    }, 620);
  }, []);

  const selectBooster = useCallback((booster: BoosterType) => {
    const controller = controllerRef.current;
    if (!controller) return;
    if ((latest.current.save.boosters[booster] ?? 0) <= 0) return;
    if (booster === 'shuffle') {
      controller.useShuffleBooster();
      return;
    }
    setActiveBooster(booster);
    controller.setActiveBooster(booster);
  }, []);

  const cancelBooster = useCallback(() => {
    setActiveBooster(null);
    controllerRef.current?.setActiveBooster(null);
  }, []);

  // Escape cancels an armed booster (hardware keyboards / Magic Keyboard).
  useEffect(() => {
    if (!activeBooster) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelBooster();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeBooster, cancelBooster]);

  /* ---------- derived ---------- */

  const playing = snapshot.status === 'playing';
  const dockLocked = !playing || snapshot.isAnimating || modal.kind !== 'none';
  const firstMoveMade = snapshot.movesLeft < level.moves;
  const showTip = !isZen && Boolean(level.tutorialHint) && !tipDismissed && !firstMoveMade && modal.kind === 'none';
  const progress = save.levels[level.id];
  const nextLevelId = level.id + 1;
  const hasNextLevel = LEVELS.some((l) => l.id === nextLevelId);
  const zenStats = isZen
    ? { bestScore: save.zenBestScore, bestCascade: Math.max(save.zenBestCascade, zenCascade) }
    : undefined;

  const baseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  const candylandUrl = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}art/bg-candyland.jpg`;
  const themeStyle = {
    '--ch-accent': chapter.accentColor,
    '--ch-from': chapter.bgFrom,
    '--ch-to': chapter.bgTo,
    '--ch-tray': chapter.trayTint,
    '--bg-candyland': `url("${candylandUrl}")`,
  } as CSSProperties;

  return (
    <div
      className={`game-screen${isZen ? ' game-screen--zen' : ''}`}
      style={themeStyle}
      data-booster={activeBooster ?? undefined}
      data-mode={mode}
    >
      <aside className="studio" aria-label="Game panel">
        <nav className="game-nav" aria-label="Game">
          <button type="button" className="icon-btn" onClick={onExitToMap} aria-label="Back to map">
            <CandyIcon kind="map" size={24} />
            <span className="icon-btn__label">Map</span>
          </button>
          {isZen ? (
            <button
              type="button"
              className="icon-btn"
              onClick={newZenBoard}
              aria-label="New board"
              disabled={snapshot.isAnimating}
            >
              <CandyIcon kind="shuffle" size={24} />
              <span className="icon-btn__label">New Board</span>
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              onClick={retry}
              aria-label="Restart level"
              disabled={snapshot.isAnimating && playing}
            >
              <CandyIcon kind="retry" size={24} />
              <span className="icon-btn__label">Retry</span>
            </button>
          )}
          <button
            type="button"
            className={`icon-btn music-switch-btn${save.settings.musicEnabled ? '' : ' is-muted'}`}
            onClick={onCycleMusicTrack}
            aria-label={
              save.settings.musicEnabled
                ? `Music: ${trackMeta.label}. Tap to switch track`
                : 'Music off. Tap to turn music on'
            }
            title={save.settings.musicEnabled ? `${trackMeta.label} — tap for next track` : 'Turn music on'}
          >
            <CandyIcon kind="music" size={22} />
            <span className="music-switch-btn__name">
              {save.settings.musicEnabled ? trackMeta.label : 'Music Off'}
            </span>
          </button>
          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
            <CandyIcon kind="settings" size={24} />
            <span className="icon-btn__label">Settings</span>
          </button>
        </nav>

        <HudPanel
          level={level}
          chapter={chapter}
          score={snapshot.score}
          movesLeft={snapshot.movesLeft}
          objectives={snapshot.objectives}
          stars={snapshot.stars}
          mode={mode}
          zenStats={zenStats}
          giftStreak={giftStreak}
        />

        <BoosterDock
          counts={save.boosters}
          active={activeBooster}
          locked={dockLocked}
          onSelect={selectBooster}
          onCancel={cancelBooster}
        />
      </aside>

      <main className="stage">
        <div className="board-slot" ref={stageRef}>
          <div
            className={`board-frame${activeBooster ? ' is-targeting' : ''}${dealing ? ' is-dealing' : ''}`}
            ref={boardRef}
          >
            <canvas
              ref={canvasRef}
              className="board-canvas"
              aria-label={
                isZen
                  ? `Endless Zen board, ${level.cols} by ${level.rows}. Swipe or tap two neighboring candies to swap.`
                  : `Level ${level.id} board, ${level.cols} by ${level.rows}. Swipe or tap two neighboring candies to swap.`
              }
              role="img"
            />
          </div>
        </div>
        {!isZen && snapshot.status === 'sugar-crush' ? (
          <button
            type="button"
            className="sugar-crush-banner"
            onClick={() => controllerRef.current?.skipSugarCrush()}
            aria-label="Skip Sugar Snap bonus animation and go to results"
          >
            Sugar Snap! · Tap to Skip
          </button>
        ) : null}
      </main>

      {!isZen && modal.kind === 'intro' && !overlayOpen ? (
        <LevelIntroSheet
          level={level}
          chapter={chapter}
          bestScore={progress?.bestScore ?? 0}
          bestStars={progress?.stars ?? 0}
          onPlay={() => {
            sound.unlock();
            latest.current.onUnlockAudio();
            setModal({ kind: 'none' });
          }}
          onMap={onExitToMap}
        />
      ) : null}

      {!isZen && modal.kind === 'won' ? (
        <VictoryModal
          level={level}
          score={modal.score}
          stars={modal.stars}
          bestScore={modal.record.bestScore}
          isNewBest={modal.record.isNewBest}
          awardedBoosters={modal.record.awardedBoosters}
          hasNextLevel={hasNextLevel}
          winStreak={save.winStreak}
          sound={sound}
          reducedMotion={reducedMotion}
          onNext={() => {
            sound.unlock();
            latest.current.onUnlockAudio();
            onPlayLevel(nextLevelId, false);
          }}
          onReplay={replay}
          onMap={onExitToMap}
        />
      ) : null}

      {!isZen && modal.kind === 'lost' ? (
        <OutOfMovesModal
          level={level}
          objectives={snapshot.objectives}
          score={modal.score}
          onRetry={retry}
          onMap={onExitToMap}
        />
      ) : null}
    </div>
  );
}
