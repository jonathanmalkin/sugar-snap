import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement } from 'react';
import type { ChapterDef, LevelDef } from '../engine/types';
import { CHAPTERS, getLevelById } from '../levels';
import { getTotalStars } from '../state/storage';
import type { PlayerSave } from '../state/storageTypes';
import { CandyIcon } from './CandyIcon';

export interface SagaMapProps {
  save: PlayerSave;
  reducedMotion: boolean;
  onPlayLevel: (levelId: number) => void;
  onOpenSettings: () => void;
}

/* Trail geometry lives in a 400-wide coordinate space; the SVG stretches horizontally. */
const VIEW_W = 400;
const STEP_Y = 132;
const PAD_Y = 84;
const AMPLITUDE = 112;

interface Node {
  level: LevelDef;
  x: number;
  y: number;
}

type DecoKind = 'lollipop' | 'gumdrop' | 'cloud' | 'cherry' | 'truffle' | 'cupcake' | 'peak';

const CHAPTER_DECOR: Record<number, DecoKind[]> = {
  1: ['lollipop', 'cupcake', 'lollipop', 'gumdrop'],
  2: ['gumdrop', 'lollipop', 'gumdrop', 'cupcake'],
  3: ['peak', 'cloud', 'peak', 'cloud'],
  4: ['cherry', 'cupcake', 'cherry', 'gumdrop'],
  5: ['truffle', 'cupcake', 'truffle', 'lollipop'],
};

function layoutChapter(chapter: ChapterDef, phase: number): { nodes: Node[]; height: number } {
  const nodes: Node[] = [];
  chapter.levelIds.forEach((id, i) => {
    const level = getLevelById(id);
    if (!level) return;
    const t = (phase + i) * (Math.PI / 2);
    nodes.push({ level, x: VIEW_W / 2 + AMPLITUDE * Math.sin(t), y: PAD_Y + i * STEP_Y });
  });
  const height = PAD_Y * 2 + Math.max(0, nodes.length - 1) * STEP_Y;
  return { nodes, height };
}

function segmentPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dy = (b.y - a.y) * 0.55;
  return `M${a.x} ${a.y} C${a.x} ${a.y + dy} ${b.x} ${b.y - dy} ${b.x} ${b.y}`;
}

function Decoration({ kind, accent }: { kind: DecoKind; accent: string }): ReactElement {
  switch (kind) {
    case 'lollipop':
      return (
        <svg viewBox="0 0 60 90" aria-hidden="true">
          <rect x="27" y="40" width="6" height="48" rx="3" fill="#f6e3cf" stroke="#c9a283" />
          <circle cx="30" cy="30" r="26" fill={accent} />
          <path d="M30 30c0-4 5-5 8-2 4 5-1 12-8 12-10 0-14-11-8-18 7-8 21-6 25 4" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity="0.85" />
          <ellipse cx="18" cy="16" rx="7" ry="3.5" fill="#fff" opacity="0.6" transform="rotate(-30 18 16)" />
        </svg>
      );
    case 'gumdrop':
      return (
        <svg viewBox="0 0 70 60" aria-hidden="true">
          <path d="M8 54C8 26 20 6 35 6s27 20 27 48z" fill={accent} />
          <path d="M8 54h54" stroke="#000" strokeOpacity="0.12" strokeWidth="5" strokeLinecap="round" />
          {[
            [24, 24],
            [40, 18],
            [46, 36],
            [30, 40],
            [18, 42],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2.4" fill="#fff" opacity="0.8" />
          ))}
          <ellipse cx="25" cy="16" rx="7" ry="3" fill="#fff" opacity="0.55" transform="rotate(-35 25 16)" />
        </svg>
      );
    case 'cloud':
      return (
        <svg viewBox="0 0 110 60" aria-hidden="true">
          <path d="M22 52c-12 0-18-8-16-16 2-9 11-12 18-9 2-12 14-20 27-16 7-8 24-8 31 4 13-2 24 7 22 20-1 10-9 17-20 17z" fill="#fff" opacity="0.92" />
          <path d="M18 48h80" stroke={accent} strokeOpacity="0.25" strokeWidth="4" strokeLinecap="round" />
        </svg>
      );
    case 'peak':
      return (
        <svg viewBox="0 0 100 80" aria-hidden="true">
          <path d="M4 76 38 14l14 18 10-12 34 56z" fill={accent} opacity="0.85" />
          <path d="M38 14 28 32l8 4 6-6 6 6 4-4zM62 20l-6 8 6 3 4-3 4 3z" fill="#fff" />
        </svg>
      );
    case 'cherry':
      return (
        <svg viewBox="0 0 70 70" aria-hidden="true">
          <path d="M22 46C26 30 32 18 44 8M50 46c-2-12-3-24-6-38" stroke="#3f7d2a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M44 8c7-4 15-2 18 4-7 3-13 3-18-4z" fill="#4caf50" />
          <circle cx="21" cy="50" r="14" fill="#d4122f" />
          <circle cx="50" cy="50" r="14" fill="#c10f2a" />
          <ellipse cx="16" cy="44" rx="5" ry="3" fill="#fff" opacity="0.7" transform="rotate(-30 16 44)" />
          <ellipse cx="45" cy="44" rx="5" ry="3" fill="#fff" opacity="0.7" transform="rotate(-30 45 44)" />
        </svg>
      );
    case 'truffle':
      return (
        <svg viewBox="0 0 70 60" aria-hidden="true">
          <path d="M6 44h58l-6 14H12z" fill={accent} opacity="0.9" />
          <circle cx="35" cy="30" r="22" fill="#4a2617" />
          <path d="M18 24c6-6 12 2 17-4s12-2 17 3" stroke="#d9a066" strokeWidth="3" fill="none" strokeLinecap="round" />
          <ellipse cx="26" cy="18" rx="6" ry="3" fill="#fff" opacity="0.35" transform="rotate(-30 26 18)" />
        </svg>
      );
    case 'cupcake':
      return (
        <svg viewBox="0 0 70 80" aria-hidden="true">
          <path d="M14 44h42l-6 32H20z" fill="#f2c79a" stroke="#c98a5e" strokeWidth="2" />
          <path d="M24 46l2 28M35 46v28M46 46l-2 28" stroke="#c98a5e" strokeWidth="2" />
          <path d="M10 46c-4-10 4-18 12-16 0-10 10-16 18-12 8-4 18 4 16 14 8 2 10 10 6 14z" fill={accent} />
          <circle cx="35" cy="12" r="6" fill="#e6396b" />
          <path d="M35 6c0-3 2-5 5-6" stroke="#3f7d2a" strokeWidth="2" fill="none" />
          <ellipse cx="24" cy="32" rx="6" ry="2.5" fill="#fff" opacity="0.55" transform="rotate(-20 24 32)" />
        </svg>
      );
  }
}

export function SagaMap({ save, reducedMotion, onPlayLevel, onOpenSettings }: SagaMapProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalStars = getTotalStars(save);
  const maxStars = CHAPTERS.reduce((n, c) => n + c.levelIds.length, 0) * 3;
  const highest = save.highestUnlockedLevel;

  const chapters = useMemo(() => {
    let phase = 0;
    return CHAPTERS.map((chapter) => {
      const layout = layoutChapter(chapter, phase);
      phase += chapter.levelIds.length;
      return { chapter, ...layout };
    });
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[data-current="true"]');
    if (!target) return;
    // Let layout + fonts settle before gliding to the current level.
    const t = window.setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    }, 120);
    return () => window.clearTimeout(t);
    // Only on mount: don't yank the map while the player browses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="saga" ref={scrollRef}>
      <header className="saga-header">
        <div className="saga-header__inner">
          <h1 className="wordmark" aria-label="Sugar Snap">
            <span className="wordmark__sugar">Sugar</span>
            <span className="wordmark__snap">Snap</span>
          </h1>
          <div className="saga-header__actions">
            <span className="star-pill" aria-label={`${totalStars} of ${maxStars} stars`}>
              <CandyIcon kind="star" size={24} />
              <strong>{totalStars}</strong>
              <span className="star-pill__max">/ {maxStars}</span>
            </span>
            <button type="button" className="btn btn--primary btn--compact" onClick={() => onPlayLevel(highest)}>
              <CandyIcon kind="play" size={20} />
              Play <span className="hide-narrow">Level&nbsp;</span>
              {highest}
            </button>
            <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
              <CandyIcon kind="settings" size={26} />
            </button>
          </div>
        </div>
      </header>

      <main className="saga-trail">
        {chapters.map(({ chapter, nodes, height }) => {
          const chapterStars = chapter.levelIds.reduce((n, id) => n + (save.levels[id]?.stars ?? 0), 0);
          const chapterMax = chapter.levelIds.length * 3;
          const firstId = chapter.levelIds[0] ?? 1;
          const lockedChapter = firstId > highest;
          const decor = CHAPTER_DECOR[chapter.id] ?? CHAPTER_DECOR[1];
          const style = {
            '--ch-accent': chapter.accentColor,
            '--ch-from': chapter.bgFrom,
            '--ch-to': chapter.bgTo,
            '--ch-tray': chapter.trayTint,
          } as CSSProperties;

          return (
            <section
              key={chapter.id}
              className={`chapter${lockedChapter ? ' is-locked' : ''}`}
              style={style}
              aria-label={`Chapter ${chapter.id}: ${chapter.name}`}
            >
              <div className="chapter-banner">
                <div className="chapter-banner__text">
                  <p className="chapter-banner__eyebrow">Chapter {chapter.id}</p>
                  <h2 className="chapter-banner__title">{chapter.name}</h2>
                  <p className="chapter-banner__tagline">{chapter.tagline}</p>
                </div>
                <span className="chapter-banner__stars" aria-label={`${chapterStars} of ${chapterMax} stars`}>
                  <CandyIcon kind="star" size={22} />
                  {chapterStars}
                  <span className="chapter-banner__max">/{chapterMax}</span>
                </span>
              </div>

              <div className="chapter-field" style={{ height }}>
                <svg
                  className="trail-svg"
                  viewBox={`0 0 ${VIEW_W} ${height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {nodes.length > 0 ? (
                    <>
                      <path
                        className="trail trail--base"
                        d={`${segmentPath({ x: VIEW_W / 2, y: -10 }, nodes[0])} ${nodes
                          .slice(1)
                          .map((n, i) => segmentPath(nodes[i], n))
                          .join(' ')} ${segmentPath(nodes[nodes.length - 1], { x: VIEW_W / 2, y: height + 10 })}`}
                      />
                      {nodes.slice(1).map((n, i) => (
                        <path
                          key={`seg-${n.level.id}`}
                          className={`trail trail--top${n.level.id <= highest ? ' is-done' : ''}`}
                          d={segmentPath(nodes[i], n)}
                        />
                      ))}
                      <path
                        className={`trail trail--top${firstId <= highest ? ' is-done' : ''}`}
                        d={segmentPath({ x: VIEW_W / 2, y: -10 }, nodes[0])}
                      />
                      <path
                        className="trail trail--sprinkles"
                        d={`${segmentPath({ x: VIEW_W / 2, y: -10 }, nodes[0])} ${nodes
                          .slice(1)
                          .map((n, i) => segmentPath(nodes[i], n))
                          .join(' ')}`}
                      />
                    </>
                  ) : null}
                </svg>

                {nodes.map((n, i) => {
                  if (i === 0 || i === nodes.length - 1 || Math.abs(n.x - VIEW_W / 2) < 8) return null;
                  const onRight = n.x < VIEW_W / 2;
                  const kind = decor[i % decor.length] ?? 'lollipop';
                  return (
                    <div
                      key={`deco-${n.level.id}`}
                      className={`deco deco--${kind}${onRight ? ' deco--right' : ' deco--left'}`}
                      style={{ top: n.y - 46 }}
                    >
                      <Decoration kind={kind} accent={chapter.accentColor} />
                    </div>
                  );
                })}
                <div className="deco deco--sm deco--left" style={{ top: PAD_Y - 30 }}>
                  <Decoration kind={decor[3] ?? 'gumdrop'} accent={chapter.accentColor} />
                </div>
                <div className="deco deco--sm deco--right" style={{ top: height - PAD_Y - 30 }}>
                  <Decoration kind={decor[2] ?? 'gumdrop'} accent={chapter.accentColor} />
                </div>

                {nodes.map((n) => {
                  const id = n.level.id;
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
                      style={{ left: `${(n.x / VIEW_W) * 100}%`, top: n.y }}
                      data-current={isCurrent ? 'true' : undefined}
                      disabled={!unlocked}
                      onClick={() => onPlayLevel(id)}
                      aria-label={
                        unlocked
                          ? `Level ${id}, ${n.level.name}${completed ? `, ${stars} stars` : ''}${isCurrent ? ', next up' : ''}`
                          : `Level ${id}, locked`
                      }
                    >
                      {isCurrent ? <span className="medallion__ring" aria-hidden="true" /> : null}
                      <span className="medallion__disc">
                        {unlocked ? (
                          <span className="medallion__num">{id}</span>
                        ) : (
                          <CandyIcon kind="lock" size={24} />
                        )}
                      </span>
                      <span className="medallion__stars" aria-hidden="true">
                        {[1, 2, 3].map((s) => (
                          <CandyIcon key={s} kind={s <= stars ? 'star' : 'star-empty'} size={s === 2 ? 20 : 17} />
                        ))}
                      </span>
                      {isCurrent ? <span className="medallion__flag">{n.level.name}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        <footer className="saga-footer">
          <CandyIcon kind="star" size={28} />
          <p>More sweets are baking in the kitchen.</p>
        </footer>
      </main>
    </div>
  );
}
