import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { ISoundEngine } from '../audio/soundTypes';
import type { BoosterType, ChapterDef, LevelDef, ObjectiveProgress, ObjectiveTarget } from '../engine/types';
import { BOOSTER_ICON, CandyIcon, objectiveIcon } from './CandyIcon';
import { formatScore } from './HudPanel';

/* ---------- shared shell ---------- */

export interface ModalShellProps {
  label: string;
  children: ReactNode;
  className?: string;
  /** Called on Escape. Backdrop taps never dismiss (protects mid-game state). */
  onEscape?: () => void;
  variant?: 'card' | 'sheet';
}

export function ModalShell({ label, children, className, onEscape, variant = 'card' }: ModalShellProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled])');
    first?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);

  return (
    <div className={`modal-backdrop modal-backdrop--${variant}`}>
      <div
        ref={ref}
        className={`modal modal--${variant}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

function ObjectivePreview({ objectives }: { objectives: ObjectiveTarget[] }): ReactElement {
  return (
    <ul className="goal-preview">
      {objectives.map((o) => {
        const icon = objectiveIcon(o);
        return (
          <li key={o.id} className="goal-preview__item">
            <span className="goal-preview__icon">
              <CandyIcon kind={icon.kind} tint={icon.tint} size={40} />
            </span>
            <span className="goal-preview__target">{o.kind === 'score' ? formatScore(o.target) : `×${o.target}`}</span>
            <span className="goal-preview__label">{o.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StarRow({ stars, size = 26 }: { stars: number; size?: number }): ReactElement {
  return (
    <span className="star-row" aria-label={`${stars} of 3 stars`}>
      {[1, 2, 3].map((n) => (
        <CandyIcon key={n} kind={n <= stars ? 'star' : 'star-empty'} size={size} />
      ))}
    </span>
  );
}

/* ---------- Level Intro ---------- */

export interface LevelIntroSheetProps {
  level: LevelDef;
  chapter: ChapterDef;
  bestScore: number;
  bestStars: 0 | 1 | 2 | 3;
  onPlay: () => void;
  onMap: () => void;
}

export function LevelIntroSheet({ level, chapter, bestScore, bestStars, onPlay, onMap }: LevelIntroSheetProps): ReactElement {
  return (
    <ModalShell label={`Level ${level.id}: ${level.name}`} variant="sheet" onEscape={onMap} className="intro-sheet">
      <div className="intro-sheet__ribbon" style={{ background: chapter.accentColor }}>
        Level {level.id}
      </div>
      <p className="modal__eyebrow">{chapter.name}</p>
      <h2 className="modal__title">{level.name}</h2>
      <p className="modal__subtitle">{level.subtitle}</p>

      <ObjectivePreview objectives={level.objectives} />

      <div className="intro-sheet__meta">
        <span className="meta-chip">
          <strong>{level.moves}</strong> moves
        </span>
        <span className="meta-chip">
          <StarRow stars={bestStars} size={20} />
        </span>
        {bestScore > 0 ? (
          <span className="meta-chip">
            Best <strong>{formatScore(bestScore)}</strong>
          </span>
        ) : null}
      </div>

      <div className="modal__actions">
        <button type="button" className="btn btn--primary btn--xl" onClick={onPlay} data-autofocus>
          <CandyIcon kind="play" size={26} />
          Play!
        </button>
        <button type="button" className="btn btn--ghost" onClick={onMap}>
          <CandyIcon kind="map" size={22} />
          Map
        </button>
      </div>
    </ModalShell>
  );
}

/* ---------- Victory ---------- */

const BOOSTER_NAMES: Record<BoosterType, string> = {
  hammer: 'Hammer',
  'free-switch': 'Free Switch',
  shuffle: 'Shuffle',
};

export interface VictoryModalProps {
  level: LevelDef;
  score: number;
  stars: 1 | 2 | 3;
  bestScore: number;
  isNewBest: boolean;
  awardedBoosters: BoosterType[];
  hasNextLevel: boolean;
  sound: ISoundEngine;
  reducedMotion: boolean;
  onNext: () => void;
  onReplay: () => void;
  onMap: () => void;
}

const VICTORY_TITLES = ['', 'Sweet!', 'Delicious!', 'Divine!'];

export function VictoryModal({
  level,
  score,
  stars,
  bestScore,
  isNewBest,
  awardedBoosters,
  hasNextLevel,
  sound,
  reducedMotion,
  onNext,
  onReplay,
  onMap,
}: VictoryModalProps): ReactElement {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    sound.playVictory();
    const timers: number[] = [];
    const start = reducedMotion ? 250 : 650;
    const step = reducedMotion ? 220 : 420;
    for (let n = 1; n <= stars; n++) {
      timers.push(
        window.setTimeout(() => {
          setShown(n);
          sound.playStar(n as 1 | 2 | 3);
        }, start + (n - 1) * step)
      );
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [sound, stars, reducedMotion]);

  // Collapse repeats ("hammer, hammer") into counts.
  const awarded = awardedBoosters.reduce<Partial<Record<BoosterType, number>>>((acc, b) => {
    acc[b] = (acc[b] ?? 0) + 1;
    return acc;
  }, {});
  const awardedList = Object.entries(awarded) as Array<[BoosterType, number]>;

  return (
    <ModalShell label="Level complete" className="victory">
      <div className="victory__glow" aria-hidden="true" />
      <p className="modal__eyebrow">Level {level.id} complete</p>
      <h2 className="modal__title victory__title">{VICTORY_TITLES[stars]}</h2>

      <div className="victory__stars" aria-label={`${stars} of 3 stars`}>
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`victory__star victory__star--${n}${n <= shown ? ' is-lit' : ''}`}
          >
            <CandyIcon kind={n <= shown ? 'star' : 'star-empty'} size={n === 2 ? 88 : 70} />
          </span>
        ))}
      </div>

      <div className="victory__score">
        <span className="victory__score-label">Score</span>
        <span className="victory__score-value">{formatScore(score)}</span>
        {isNewBest ? (
          <span className="badge badge--honey">New best!</span>
        ) : (
          <span className="badge">Best {formatScore(bestScore)}</span>
        )}
      </div>

      {awardedList.length > 0 ? (
        <div className="reward-callout" role="status">
          <CandyIcon kind="gift" size={36} />
          <div className="reward-callout__text">
            <strong>Star reward unlocked</strong>
            <span>
              {awardedList.map(([b, n], i) => (
                <span key={b} className="reward-callout__item">
                  <CandyIcon kind={BOOSTER_ICON[b]} size={20} />
                  {n > 1 ? `${n}× ` : '+1 '}
                  {BOOSTER_NAMES[b]}
                  {i < awardedList.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </span>
          </div>
        </div>
      ) : null}

      <div className="modal__actions">
        {hasNextLevel ? (
          <button type="button" className="btn btn--primary btn--xl" onClick={onNext} data-autofocus>
            Next Level
            <CandyIcon kind="play" size={22} />
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--xl" onClick={onMap} data-autofocus>
            You finished Sugar Snap!
          </button>
        )}
        <div className="modal__actions-row">
          <button type="button" className="btn btn--secondary" onClick={onReplay}>
            <CandyIcon kind="retry" size={22} />
            Replay
          </button>
          <button type="button" className="btn btn--secondary" onClick={onMap}>
            <CandyIcon kind="map" size={22} />
            Map
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- Out of moves ---------- */

export interface OutOfMovesModalProps {
  level: LevelDef;
  objectives: ObjectiveProgress[];
  score: number;
  onRetry: () => void;
  onMap: () => void;
}

export function OutOfMovesModal({ level, objectives, score, onRetry, onMap }: OutOfMovesModalProps): ReactElement {
  const remaining = objectives.filter((o) => !o.completed);
  return (
    <ModalShell label="Out of moves" className="out-of-moves">
      <div className="out-of-moves__art" aria-hidden="true">
        <CandyIcon kind="yellow" size={64} />
      </div>
      <p className="modal__eyebrow">Level {level.id}</p>
      <h2 className="modal__title">So close!</h2>
      <p className="modal__subtitle">Every try teaches the board a little more. Have another go — it's on the house.</p>

      {remaining.length > 0 ? (
        <ul className="goal-preview goal-preview--remaining">
          {remaining.map((o) => {
            const icon = objectiveIcon(o);
            const left = Math.max(0, o.target - o.current);
            return (
              <li key={o.id} className="goal-preview__item">
                <span className="goal-preview__icon">
                  <CandyIcon kind={icon.kind} tint={icon.tint} size={36} />
                </span>
                <span className="goal-preview__target">{o.kind === 'score' ? formatScore(left) : left}</span>
                <span className="goal-preview__label">to go</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="out-of-moves__score">
        Score <strong>{formatScore(score)}</strong>
      </p>

      <div className="modal__actions">
        <button type="button" className="btn btn--primary btn--xl" onClick={onRetry} data-autofocus>
          <CandyIcon kind="retry" size={24} />
          Try Again
        </button>
        <button type="button" className="btn btn--ghost" onClick={onMap}>
          <CandyIcon kind="map" size={22} />
          Map
        </button>
      </div>
    </ModalShell>
  );
}
