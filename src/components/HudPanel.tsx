import type { ReactElement } from 'react';
import type { ChapterDef, LevelDef, ObjectiveProgress } from '../engine/types';
import { CandyIcon, objectiveIcon } from './CandyIcon';

export interface HudPanelProps {
  level: LevelDef;
  chapter: ChapterDef;
  score: number;
  movesLeft: number;
  objectives: ObjectiveProgress[];
  stars: 0 | 1 | 2 | 3;
}

export function formatScore(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

function compact(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return n.toLocaleString('en-US');
}

/** Sculpted moves dial: a ring that drains as moves are spent. */
function MovesDial({ movesLeft, total }: { movesLeft: number; total: number }): ReactElement {
  const low = movesLeft <= 5;
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const frac = total > 0 ? Math.max(0, Math.min(1, movesLeft / total)) : 0;
  return (
    <div className={`moves-dial${low ? ' is-low' : ''}`} role="status" aria-label={`${movesLeft} moves left`}>
      <svg className="moves-dial__ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="moves-dial__track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="moves-dial__fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="moves-dial__core">
        <span className="moves-dial__value" key={movesLeft}>
          {movesLeft}
        </span>
        <span className="moves-dial__label">moves</span>
      </div>
    </div>
  );
}

function ObjectivePill({ obj }: { obj: ObjectiveProgress }): ReactElement {
  const icon = objectiveIcon(obj);
  const current = Math.min(obj.current, obj.target);
  const text = obj.kind === 'score' ? `${compact(current)} / ${compact(obj.target)}` : `${current} / ${obj.target}`;
  return (
    <li
      className={`objective-pill${obj.completed ? ' is-done' : ''}`}
      aria-label={`${obj.label}: ${current} of ${obj.target}${obj.completed ? ', complete' : ''}`}
    >
      <span className="objective-pill__icon">
        <CandyIcon kind={icon.kind} tint={icon.tint} size={30} />
        {obj.completed ? (
          <span className="objective-pill__check">
            <CandyIcon kind="check" size={14} />
          </span>
        ) : null}
      </span>
      <span className="objective-pill__text">
        <span className="objective-pill__count">{text}</span>
        <span className="objective-pill__label">{obj.label}</span>
      </span>
    </li>
  );
}

/** Horizontal score meter with three glowing star milestones. */
export function StarMeter({
  score,
  thresholds,
}: {
  score: number;
  thresholds: [number, number, number];
}): ReactElement {
  const max = Math.max(1, thresholds[2]);
  const pct = Math.max(0, Math.min(1, score / max)) * 100;
  return (
    <div className="star-meter" aria-hidden="true">
      <div className="star-meter__track">
        <div className="star-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      {thresholds.map((t, i) => {
        const lit = score >= t;
        const left = Math.max(0, Math.min(1, t / max)) * 100;
        return (
          <span key={i} className={`star-meter__mark${lit ? ' is-lit' : ''}`} style={{ left: `${left}%` }}>
            <CandyIcon kind={lit ? 'star' : 'star-empty'} size={i === 2 ? 26 : 22} />
          </span>
        );
      })}
    </div>
  );
}

export function HudPanel({ level, chapter, score, movesLeft, objectives, stars }: HudPanelProps): ReactElement {
  return (
    <section className="hud" aria-label="Level status">
      <div className="hud__badge">
        <span className="hud__chapter">{chapter.name}</span>
        <span className="hud__level">Level {level.id}</span>
        <span className="hud__name">{level.name}</span>
      </div>

      <MovesDial movesLeft={movesLeft} total={level.moves} />

      <div className="hud__objectives">
        <h2 className="hud__heading">Goals</h2>
        <ul className="objective-list">
          {objectives.map((o) => (
            <ObjectivePill key={o.id} obj={o} />
          ))}
        </ul>
      </div>

      <div className="hud__score" aria-label={`Score ${formatScore(score)}, ${stars} of 3 stars`}>
        <div className="hud__score-row">
          <span className="hud__heading">Score</span>
          <span className="hud__score-value">{formatScore(score)}</span>
        </div>
        <StarMeter score={score} thresholds={level.starThresholds} />
      </div>
    </section>
  );
}

export interface TutorialTipProps {
  hint: string;
  onDismiss: () => void;
}

/** Soft floating tip shown over the board on tutorial levels. */
export function TutorialTip({ hint, onDismiss }: TutorialTipProps): ReactElement {
  return (
    <div className="tutorial-tip" role="note">
      <span className="tutorial-tip__icon">
        <CandyIcon kind="yellow" size={26} />
      </span>
      <p className="tutorial-tip__text">{hint}</p>
      <button type="button" className="icon-btn icon-btn--ghost tutorial-tip__close" onClick={onDismiss} aria-label="Dismiss tip">
        <CandyIcon kind="close" size={20} />
      </button>
    </div>
  );
}
