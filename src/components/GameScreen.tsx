import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { ISoundEngine } from '../audio/soundTypes';
import { createGameState } from '../engine';
import type { BoosterType, GameState, ObjectiveProgress } from '../engine/types';
import { getChapterById, getLevelById, LEVELS } from '../levels';
import { GameController } from '../renderer';
import type { PlayerSave } from '../state/storageTypes';
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

export interface GameScreenProps {
  levelId: number;
  save: PlayerSave;
  sound: ISoundEngine;
  showIntro: boolean;
  /** True when Settings (owned by App) is open on top of the game. */
  overlayOpen: boolean;
  onExitToMap: () => void;
  onOpenSettings: () => void;
  onPlayLevel: (levelId: number) => void;
  onBoosterConsumed: (booster: BoosterType) => void;
  onLevelWon: (levelId: number, score: number, stars: 1 | 2 | 3) => LevelWinRecord;
  onUnlockAudio: () => void;
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
  const { levelId, save, sound, showIntro, overlayOpen, onExitToMap, onOpenSettings, onPlayLevel } = props;
  const level = useMemo(() => getLevelById(levelId), [levelId]);
  const chapter = useMemo(() => getChapterById(level.chapterId), [level]);
  const { colorblindMode, reducedMotion } = save.settings;

  const stageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const endTimerRef = useRef<number | null>(null);

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
  const [modal, setModal] = useState<ModalState>(showIntro ? { kind: 'intro' } : { kind: 'none' });
  const [activeBooster, setActiveBooster] = useState<BoosterType | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);

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
    const initialState = createGameState(level);
    setSnapshot(snapshotFrom(initialState));
    setActiveBooster(null);

    const controller = new GameController({
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
      onLevelEnd: (result: ControllerEnd) => {
        if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
        const delay = displayRef.current.reducedMotion ? 150 : 450;
        if (result.won) {
          const stars = Math.max(1, result.stars) as 1 | 2 | 3;
          const record = latest.current.onLevelWon(level.id, result.score, stars);
          endTimerRef.current = window.setTimeout(() => {
            setModal({ kind: 'won', score: result.score, stars, record });
          }, delay);
        } else {
          endTimerRef.current = window.setTimeout(() => {
            sound.playDefeat();
            setModal((m) => (m.kind === 'won' ? m : { kind: 'lost', score: result.score }));
          }, delay);
        }
      },
    });
    controllerRef.current = controller;
    fitBoard();
    controller.start();

    return () => {
      if (endTimerRef.current !== null) window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // runKey restarts the level from scratch (Retry / Replay).
  }, [level, chapter, sound, runKey, fitBoard]);

  useEffect(() => {
    controllerRef.current?.setDisplayOptions({ colorblindMode, reducedMotion });
  }, [colorblindMode, reducedMotion]);

  // Controller is the source of truth for booster selection once it reports one.
  useEffect(() => {
    setActiveBooster(snapshot.activeBooster);
  }, [snapshot.activeBooster]);

  /* ---------- actions ---------- */

  const restart = useCallback(() => {
    setModal({ kind: 'none' });
    setRunKey((k) => k + 1);
  }, []);

  const selectBooster = useCallback(
    (booster: BoosterType) => {
      const controller = controllerRef.current;
      if (!controller) return;
      if ((latest.current.save.boosters[booster] ?? 0) <= 0) return;
      if (booster === 'shuffle') {
        controller.useShuffleBooster();
        return;
      }
      setActiveBooster(booster);
      controller.setActiveBooster(booster);
    },
    []
  );

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
  const showTip = Boolean(level.tutorialHint) && !tipDismissed && !firstMoveMade && modal.kind === 'none';
  const progress = save.levels[level.id];
  const nextLevelId = level.id + 1;
  const hasNextLevel = LEVELS.some((l) => l.id === nextLevelId);

  const themeStyle = {
    '--ch-accent': chapter.accentColor,
    '--ch-from': chapter.bgFrom,
    '--ch-to': chapter.bgTo,
    '--ch-tray': chapter.trayTint,
  } as CSSProperties;

  return (
    <div className="game-screen" style={themeStyle} data-booster={activeBooster ?? undefined}>
      <aside className="studio" aria-label="Game panel">
        <nav className="game-nav" aria-label="Game">
          <button type="button" className="icon-btn" onClick={onExitToMap} aria-label="Back to map">
            <CandyIcon kind="map" size={24} />
            <span className="icon-btn__label">Map</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={restart}
            aria-label="Restart level"
            disabled={snapshot.isAnimating && playing}
          >
            <CandyIcon kind="retry" size={24} />
            <span className="icon-btn__label">Retry</span>
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
        {showTip && level.tutorialHint ? (
          <TutorialTip hint={level.tutorialHint} onDismiss={() => setTipDismissed(true)} />
        ) : null}
        <div className="board-slot" ref={stageRef}>
          <div className={`board-frame${activeBooster ? ' is-targeting' : ''}`} ref={boardRef}>
            <canvas
              ref={canvasRef}
              className="board-canvas"
              aria-label={`Level ${level.id} board, ${level.cols} by ${level.rows}. Swipe or tap two neighboring candies to swap.`}
              role="img"
            />
          </div>
        </div>
        {snapshot.status === 'sugar-crush' ? (
          <div className="sugar-crush-banner" role="status">
            Sugar Crush!
          </div>
        ) : null}
      </main>

      {modal.kind === 'intro' && !overlayOpen ? (
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

      {modal.kind === 'won' ? (
        <VictoryModal
          level={level}
          score={modal.score}
          stars={modal.stars}
          bestScore={modal.record.bestScore}
          isNewBest={modal.record.isNewBest}
          awardedBoosters={modal.record.awardedBoosters}
          hasNextLevel={hasNextLevel}
          sound={sound}
          reducedMotion={reducedMotion}
          onNext={() => onPlayLevel(nextLevelId)}
          onReplay={restart}
          onMap={onExitToMap}
        />
      ) : null}

      {modal.kind === 'lost' ? (
        <OutOfMovesModal
          level={level}
          objectives={snapshot.objectives}
          score={modal.score}
          onRetry={restart}
          onMap={onExitToMap}
        />
      ) : null}
    </div>
  );
}
