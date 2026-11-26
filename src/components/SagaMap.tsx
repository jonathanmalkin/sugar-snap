import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { LevelDef } from '../engine/types';
import { CHAPTERS, getLevelById } from '../levels';
import { getTotalStars } from '../state/storage';
import type { PlayerSave } from '../state/storageTypes';
import { CandyIcon } from './CandyIcon';
import { formatScore } from './HudPanel';
import { WorldMapCanvas, WorldParticles, buildWorldLayout, type WorldNode } from './WorldMapCanvas';

export interface SagaMapProps {
  save: PlayerSave;
  reducedMotion: boolean;
  onPlayLevel: (levelId: number) => void;
  onPlayZen: () => void;
  onOpenSettings: () => void;
}

function safeLevel(id: number): LevelDef | null {
  try {
    return getLevelById(id);
  } catch {
    return null;
  }
}

function initialWidth(): number {
  return typeof window === 'undefined' ? 1024 : window.innerWidth || 1024;
}

export function SagaMap({ save, reducedMotion, onPlayLevel, onPlayZen, onOpenSettings }: SagaMapProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const totalStars = getTotalStars(save);
  const maxStars = CHAPTERS.reduce((n, c) => n + c.levelIds.length, 0) * 3;
  const highest = save.highestUnlockedLevel;
  const currentLevel = safeLevel(highest);
  const winStreak = save.winStreak;
  const zenActive = save.zenState !== null;
  const zenSub = zenActive
    ? `Resume · ${formatScore(save.zenState?.score ?? 0)}`
    : save.zenBestScore > 0
      ? `Best ${formatScore(save.zenBestScore)}`
      : 'No moves limit';

  /* The world is laid out in real pixels for the live viewport width. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => buildWorldLayout(width, CHAPTERS), [width]);
  const nodeById = useMemo(() => {
    const m = new Map<number, WorldNode>();
    layout.nodes.forEach((n) => m.set(n.levelId, n));
    return m;
  }, [layout]);

  /* Glide to the current level on arrival (y is width-independent, so measure-free). */
  useEffect(() => {
    const root = scrollRef.current;
    const node = nodeById.get(highest);
    if (!root || !node) return;
    const t = window.setTimeout(() => {
      const top = Math.max(0, node.y - root.clientHeight * 0.52);
      if (typeof root.scrollTo === 'function') {
        root.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
      } else {
        root.scrollTop = top;
      }
    }, 140);
    return () => window.clearTimeout(t);
    // Only on mount: don't yank the map while the player browses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`saga-shell${reducedMotion ? ' is-calm' : ''}`}>
      <div className="saga" ref={scrollRef}>
        <div className="saga-world" style={{ height: layout.height }}>
          <WorldMapCanvas layout={layout} progressLevelId={highest} />

          {CHAPTERS.map((chapter, c) => {
            const sign = layout.signs[c];
            const chapterStars = chapter.levelIds.reduce((n, id) => n + (save.levels[id]?.stars ?? 0), 0);
            const chapterMax = chapter.levelIds.length * 3;
            const firstId = chapter.levelIds[0] ?? 1;
            const lockedChapter = firstId > highest;
            const accent = { '--ch-accent': chapter.accentColor } as CSSProperties;

            return (
              <section
                key={chapter.id}
                className={`chapter-zone${lockedChapter ? ' is-locked' : ''}`}
                aria-label={`Chapter ${chapter.id}: ${chapter.name}`}
              >
                {sign ? (
                  <div
                    className={`signpost signpost--${sign.side}`}
                    style={{ ...accent, left: sign.x, top: sign.y, width: sign.width }}
                  >
                    <span className="signpost__post" aria-hidden="true" />
                    <span className="signpost__tail signpost__tail--l" aria-hidden="true" />
                    <span className="signpost__tail signpost__tail--r" aria-hidden="true" />
                    <div className="signpost__ribbon">
                      <p className="signpost__eyebrow">Chapter {chapter.id}</p>
                      <h2 className="signpost__title">{chapter.name}</h2>
                      <p className="signpost__tagline">{chapter.tagline}</p>
                      {lockedChapter ? (
                        <span className="signpost__stars signpost__stars--locked">
                          <CandyIcon kind="lock" size={16} />
                          Locked
                        </span>
                      ) : (
                        <span className="signpost__stars" aria-label={`${chapterStars} of ${chapterMax} stars`}>
                          <CandyIcon kind="star" size={20} />
                          {chapterStars}
                          <span className="signpost__max">/{chapterMax}</span>
                        </span>
                      )}
                    </div>
                  </div>
                ) : null}

                {chapter.levelIds.map((id) => {
                  const node = nodeById.get(id);
                  const level = safeLevel(id);
                  if (!node || !level) return null;
                  const progress = save.levels[id];
                  const stars = progress?.stars ?? 0;
                  const unlocked = id <= highest;
                  const isCurrent = id === highest;
                  const completed = progress?.completed ?? false;
                  const state = !unlocked ? 'locked' : isCurrent ? 'current' : completed ? 'done' : 'open';
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`medallion medallion--${state}`}
                      style={{ ...accent, left: node.x, top: node.y }}
                      data-current={isCurrent ? 'true' : undefined}
                      disabled={!unlocked}
                      onClick={() => onPlayLevel(id)}
                      aria-label={
                        unlocked
                          ? `Level ${id}, ${level.name}${completed ? `, ${stars} stars` : ''}${isCurrent ? ', next up' : ''}`
                          : `Level ${id}, locked`
                      }
                    >
                      <span className="medallion__shadow" aria-hidden="true" />
                      {isCurrent ? <span className="medallion__ring" aria-hidden="true" /> : null}
                      <span className="medallion__disc">
                        <span className="medallion__face">
                          {unlocked ? (
                            <span className="medallion__num">{id}</span>
                          ) : (
                            <CandyIcon kind="lock" size={26} />
                          )}
                        </span>
                      </span>
                      {unlocked ? (
                        <span className="medallion__stars" aria-hidden="true">
                          {[1, 2, 3].map((s) => (
                            <span key={s} className={`medallion__star medallion__star--${s}${s <= stars ? ' is-lit' : ''}`}>
                              <CandyIcon kind={s <= stars ? 'star' : 'star-empty'} size={s === 2 ? 26 : 22} />
                            </span>
                          ))}
                        </span>
                      ) : null}
                      {isCurrent ? (
                        <span className="medallion__pin" aria-hidden="true">
                          <span className="medallion__pin-head">
                            <CandyIcon kind="play" size={22} />
                          </span>
                        </span>
                      ) : null}
                      {isCurrent ? <span className="medallion__flag">{level.name}</span> : null}
                    </button>
                  );
                })}
              </section>
            );
          })}

          <footer className="saga-footer" style={{ top: layout.gate.y + 58 }}>
            <CandyIcon kind="star" size={24} />
            <p>More sweets are baking</p>
          </footer>
        </div>
      </div>

      <WorldParticles scrollRef={scrollRef} bands={layout.bands} reducedMotion={reducedMotion} />
      <div className="saga-vignette" aria-hidden="true" />

      <header className="saga-chrome">
        <h1 className="saga-emblem" aria-label="Sugar Snap">
          <span className="saga-emblem__shine" aria-hidden="true" />
          <span className="wordmark" aria-hidden="true">
            <span className="wordmark__sugar">Sugar</span>
            <span className="wordmark__snap">Snap</span>
          </span>
        </h1>
        <div className="saga-chrome__cluster">
          {winStreak >= 1 ? (
            <span className="streak-pill" role="img" aria-label={`Win streak ${winStreak}`}>
              <span className="streak-pill__flame" aria-hidden="true">
                <CandyIcon kind="flame" size={24} />
              </span>
              <span className="streak-pill__label" aria-hidden="true">
                Streak
              </span>
              <strong aria-hidden="true">×{winStreak}</strong>
            </span>
          ) : null}
          <span className="star-pill" role="img" aria-label={`${totalStars} of ${maxStars} stars`}>
            <span className="star-pill__gem" aria-hidden="true">
              <CandyIcon kind="star" size={30} />
            </span>
            <strong>{totalStars}</strong>
            <span className="star-pill__max">/ {maxStars}</span>
          </span>
          <button type="button" className="gear-coin" onClick={onOpenSettings} aria-label="Settings">
            <CandyIcon kind="settings" size={28} />
          </button>
        </div>
      </header>

      <div className="saga-cta-dock">
        <button type="button" className="saga-cta" onClick={() => onPlayLevel(highest)}>
          <span className="saga-cta__jewel" aria-hidden="true">
            <CandyIcon kind="play" size={26} />
          </span>
          <span className="saga-cta__text">
            <span className="saga-cta__label">Play Level {highest}</span>
            {currentLevel ? <span className="saga-cta__name">{currentLevel.name}</span> : null}
          </span>
        </button>
        <button
          type="button"
          className={`saga-cta saga-cta--zen${zenActive ? ' is-resume' : ''}`}
          onClick={onPlayZen}
          aria-label={`Endless Zen, ${zenSub}`}
        >
          <span className="saga-cta__jewel saga-cta__jewel--zen" aria-hidden="true">
            <CandyIcon kind="infinity" size={34} />
          </span>
          <span className="saga-cta__text" aria-hidden="true">
            <span className="saga-cta__label">Endless Zen</span>
            <span className="saga-cta__name">{zenSub}</span>
          </span>
        </button>
      </div>
    </div>
  );
}
