import type { ReactElement } from 'react';
import type { BoosterType } from '../engine/types';
import { BOOSTER_ICON, CandyIcon } from './CandyIcon';

export interface BoosterDockProps {
  counts: Record<BoosterType, number>;
  active: BoosterType | null;
  /** True while the board is animating or the level is not in play. */
  locked: boolean;
  onSelect: (booster: BoosterType) => void;
  onCancel: () => void;
}

const BOOSTERS: Array<{ type: BoosterType; name: string; hint: string; prompt: string }> = [
  { type: 'hammer', name: 'Hammer', hint: 'Smash any tile', prompt: 'Tap any candy or blocker to smash' },
  { type: 'free-switch', name: 'Free Switch', hint: 'Swap any two', prompt: 'Swap any two adjacent candies' },
  { type: 'shuffle', name: 'Shuffle', hint: 'Mix the board', prompt: 'Shuffling…' },
];

export function BoosterDock({ counts, active, locked, onSelect, onCancel }: BoosterDockProps): ReactElement {
  const activeDef = active ? BOOSTERS.find((b) => b.type === active) : undefined;
  return (
    <section className={`booster-dock${active ? ' has-active' : ''}`} aria-label="Boosters">
      {activeDef && active !== 'shuffle' ? (
        <div className="booster-prompt" role="status" aria-live="polite">
          <CandyIcon kind={BOOSTER_ICON[activeDef.type]} size={26} />
          <span className="booster-prompt__text">{activeDef.prompt}</span>
          <button type="button" className="booster-prompt__cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}

      <div className="booster-dock__row">
        {BOOSTERS.map((b) => {
          const count = Math.max(0, counts[b.type] ?? 0);
          const isActive = active === b.type;
          const disabled = !isActive && (count === 0 || locked || (active !== null && b.type === 'shuffle'));
          return (
            <button
              key={b.type}
              type="button"
              className={`booster${isActive ? ' is-active' : ''}${count === 0 ? ' is-empty' : ''}`}
              disabled={disabled}
              aria-pressed={b.type === 'shuffle' ? undefined : isActive}
              aria-label={`${b.name}, ${count} left. ${b.hint}`}
              onClick={() => (isActive ? onCancel() : onSelect(b.type))}
            >
              <span className="booster__icon">
                <CandyIcon kind={BOOSTER_ICON[b.type]} size={34} />
              </span>
              <span className="booster__text">
                <span className="booster__name">{b.name}</span>
                <span className="booster__hint">{b.hint}</span>
              </span>
              <span className="booster__count" aria-hidden="true">
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
