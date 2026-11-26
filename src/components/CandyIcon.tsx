import { useId, type CSSProperties, type ReactElement } from 'react';
import type { BoosterType, CandyColor, ObjectiveTarget } from '../engine/types';

/**
 * Crisp inline SVG icon set for Sugar Snap.
 * Candy silhouettes mirror the board sprites (Ruby Bean, Tangerine Lozenge,
 * Lemon Star, Emerald Mint Square, Sapphire Swirl, Amethyst Bonbon) so HUD
 * objectives read instantly as "that candy".
 */
export type IconKind =
  | CandyColor
  | 'jelly'
  | 'cherry'
  | 'hazelnut'
  | 'star'
  | 'star-empty'
  | 'striped'
  | 'wrapped'
  | 'color-bomb'
  | 'hammer'
  | 'free-switch'
  | 'shuffle'
  | 'sound'
  | 'music'
  | 'settings'
  | 'map'
  | 'retry'
  | 'lock'
  | 'check'
  | 'close'
  | 'share'
  | 'add-square'
  | 'play'
  | 'gift'
  | 'seeker'
  | 'infinity'
  | 'flame';

export interface CandyIconProps {
  kind: IconKind;
  size?: number;
  /** Tints special candies (striped / wrapped) with a candy color. */
  tint?: CandyColor;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

interface Tone {
  light: string;
  base: string;
  dark: string;
}

export const CANDY_TONES: Record<CandyColor, Tone> = {
  red: { light: '#ff9aa8', base: '#ec2a4a', dark: '#9e0f2a' },
  orange: { light: '#ffc98a', base: '#ff8a1f', dark: '#b9500a' },
  yellow: { light: '#fff4a8', base: '#ffd01f', dark: '#c78f00' },
  green: { light: '#a6f3c6', base: '#2cbf78', dark: '#0f7446' },
  blue: { light: '#acd9ff', base: '#2f8bff', dark: '#1349b0' },
  purple: { light: '#e7bcff', base: '#a24ee6', dark: '#5f1d9e' },
};

export const CANDY_NAMES: Record<CandyColor, string> = {
  red: 'Ruby Bean',
  orange: 'Tangerine Lozenge',
  yellow: 'Lemon Star',
  green: 'Emerald Mint',
  blue: 'Sapphire Swirl',
  purple: 'Amethyst Bonbon',
};

export const BOOSTER_ICON: Record<BoosterType, IconKind> = {
  hammer: 'hammer',
  'free-switch': 'free-switch',
  shuffle: 'shuffle',
};

/** Picks the most legible icon for an objective pill. */
export function objectiveIcon(obj: ObjectiveTarget): { kind: IconKind; tint?: CandyColor } {
  switch (obj.kind) {
    case 'score':
      return { kind: 'star' };
    case 'jelly':
      return { kind: 'jelly' };
    case 'ingredients':
      return { kind: obj.ingredient ?? 'cherry' };
    case 'order': {
      const special = obj.special;
      if (special === 'striped-h' || special === 'striped-v') return { kind: 'striped', tint: obj.color };
      if (special === 'wrapped') return { kind: 'wrapped', tint: obj.color };
      if (special === 'color-bomb') return { kind: 'color-bomb' };
      if (special === 'seeker') return { kind: 'seeker', tint: obj.color };
      return { kind: obj.color ?? 'red' };
    }
    default:
      return { kind: 'star' };
  }
}

/* ---------- geometry helpers (computed once) ---------- */

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (-90 + i * 36) * (Math.PI / 180);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

function scallopPath(cx: number, cy: number, r: number, bumps: number, depth: number): string {
  const steps = bumps * 8;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const rr = r - depth * (0.5 - 0.5 * Math.cos(a * bumps));
    const x = cx + rr * Math.cos(a);
    const y = cy + rr * Math.sin(a);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return `${d}Z`;
}

const STAR_D = starPath(24, 25.5, 20, 9.4);
const BONBON_D = scallopPath(24, 25, 18.5, 10, 2.6);
const BEAN_D =
  'M9.6 29.5C5.6 19.6 13.4 8.6 25.4 9.2c10.6.5 17.2 8 14.3 16.6-2 6-8.6 5.6-12.6 8.6-4.6 3.4-5.4 7.6-11.6 7.2-4.8-.4-7.6-5-5.9-12.1z';
const LOZENGE_D = 'M24 5.5 40.5 15v18L24 42.5 7.5 33V15z';

/* ---------- component ---------- */

export function CandyIcon({ kind, size = 28, tint, className, style, title }: CandyIconProps): ReactElement {
  const rawId = useId();
  const id = `ci${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const body = renderBody(kind, id, tint);
  return (
    <svg
      className={className ? `candy-icon ${className}` : 'candy-icon'}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {body}
    </svg>
  );
}

function candyGradient(id: string, tone: Tone): ReactElement {
  return (
    <defs>
      <radialGradient id={`${id}-g`} cx="36%" cy="30%" r="75%">
        <stop offset="0%" stopColor={tone.light} />
        <stop offset="45%" stopColor={tone.base} />
        <stop offset="100%" stopColor={tone.dark} />
      </radialGradient>
      <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

function Shine({ id, x, y, rx, ry, rotate = -24 }: { id: string; x: number; y: number; rx: number; ry: number; rotate?: number }) {
  return (
    <ellipse
      cx={x}
      cy={y}
      rx={rx}
      ry={ry}
      fill={`url(#${id}-s)`}
      transform={`rotate(${rotate} ${x} ${y})`}
    />
  );
}

const SHADOW = <ellipse cx="24" cy="44" rx="13" ry="2.4" fill="#3b2318" opacity="0.16" />;

function candyBody(color: CandyColor, id: string): ReactElement {
  const tone = CANDY_TONES[color];
  const fill = `url(#${id}-g)`;
  const rim = tone.dark;
  switch (color) {
    case 'red':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <path d={BEAN_D} fill={fill} stroke={rim} strokeWidth="1.2" />
          <Shine id={id} x={19} y={16.5} rx={7.5} ry={3.4} rotate={-18} />
          <circle cx="33" cy="20" r="1.6" fill="#fff" opacity="0.7" />
        </g>
      );
    case 'orange':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <path d={LOZENGE_D} fill={fill} stroke={rim} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M24 12 34 18v12l-10 6-10-6V18z" fill="#fff" opacity="0.16" />
          <path d="M24 5.5V12M40.5 15 34 18M7.5 15 14 18M24 42.5V36" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.1" />
          <Shine id={id} x={18} y={14} rx={6} ry={2.8} rotate={-30} />
        </g>
      );
    case 'yellow':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <path d={STAR_D} fill={fill} stroke={fill} strokeWidth="5" strokeLinejoin="round" />
          <path d={STAR_D} fill="none" stroke={rim} strokeWidth="1" strokeLinejoin="round" opacity="0.55" />
          <Shine id={id} x={19.5} y={17} rx={5.6} ry={2.6} rotate={-28} />
        </g>
      );
    case 'green':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <rect x="7.5" y="7.5" width="33" height="33" rx="10" fill={fill} stroke={rim} strokeWidth="1.3" />
          <rect x="13" y="13" width="22" height="22" rx="6.5" fill="none" stroke="#fff" strokeOpacity="0.4" strokeWidth="1.6" />
          <Shine id={id} x={18} y={14} rx={7} ry={2.8} rotate={-14} />
        </g>
      );
    case 'blue':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <circle cx="24" cy="24.5" r="17.5" fill={fill} stroke={rim} strokeWidth="1.3" />
          <path
            d="M24 24.5c0-2 2.6-2.8 4-1.2 2.2 2.4-.4 6.4-4 6.4-5 0-7.4-5.6-4.6-9.8 3.4-5 11.4-4.6 14.2 1.2 3.2 6.6-1.6 14-9.6 14"
            fill="none"
            stroke="#fff"
            strokeOpacity="0.85"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <Shine id={id} x={17.5} y={13.5} rx={6.4} ry={2.8} />
        </g>
      );
    case 'purple':
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <path d={BONBON_D} fill={fill} stroke={rim} strokeWidth="1.2" strokeLinejoin="round" />
          <circle cx="24" cy="25" r="10" fill="none" stroke="#fff" strokeOpacity="0.32" strokeWidth="1.6" />
          <Shine id={id} x={18} y={15} rx={6.4} ry={2.8} />
        </g>
      );
  }
}

function renderBody(kind: IconKind, id: string, tint?: CandyColor): ReactElement {
  switch (kind) {
    case 'red':
    case 'orange':
    case 'yellow':
    case 'green':
    case 'blue':
    case 'purple':
      return candyBody(kind, id);

    case 'jelly':
      return (
        <g>
          <defs>
            <linearGradient id={`${id}-j`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff9fc0" />
              <stop offset="100%" stopColor="#e6396b" />
            </linearGradient>
          </defs>
          {SHADOW}
          <path
            d="M8 14c0-4 2.6-6.5 6.5-6.5h19c3.9 0 6.5 2.5 6.5 6.5v18.5c0 4-2.6 7.5-6.5 7.5-2.6 0-3-2.2-5.2-2.2s-2.6 2.2-4.8 2.2-2.6-2.2-4.8-2.2-2.6 2.2-5.2 2.2C10.6 40 8 36.5 8 32.5z"
            fill={`url(#${id}-j)`}
            stroke="#b0164a"
            strokeWidth="1.2"
            opacity="0.95"
          />
          <path d="M13 13.5h14" stroke="#fff" strokeOpacity="0.75" strokeWidth="3" strokeLinecap="round" />
          <circle cx="32" cy="14" r="1.6" fill="#fff" opacity="0.75" />
        </g>
      );

    case 'cherry':
      return (
        <g>
          <defs>
            <radialGradient id={`${id}-c`} cx="35%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#ff8a9a" />
              <stop offset="50%" stopColor="#d4122f" />
              <stop offset="100%" stopColor="#7a0618" />
            </radialGradient>
          </defs>
          {SHADOW}
          <path d="M16 30C18 20 22 12 30 6M33 31c-1-8-1.5-16-3-25" stroke="#3f7d2a" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M30 6c4-2 9-1 11 3-4 2-8 2-11-3z" fill="#4caf50" stroke="#2e7d32" strokeWidth="1" />
          <circle cx="15" cy="33" r="9" fill={`url(#${id}-c)`} />
          <circle cx="33" cy="33" r="9" fill={`url(#${id}-c)`} />
          <ellipse cx="12" cy="29.5" rx="3" ry="1.8" fill="#fff" opacity="0.8" transform="rotate(-30 12 29.5)" />
          <ellipse cx="30" cy="29.5" rx="3" ry="1.8" fill="#fff" opacity="0.8" transform="rotate(-30 30 29.5)" />
        </g>
      );

    case 'hazelnut':
      return (
        <g>
          <defs>
            <radialGradient id={`${id}-h`} cx="38%" cy="40%" r="70%">
              <stop offset="0%" stopColor="#e0a56b" />
              <stop offset="55%" stopColor="#a8622e" />
              <stop offset="100%" stopColor="#5e3114" />
            </radialGradient>
          </defs>
          {SHADOW}
          <path d="M24 42c-9 0-14-7-14-15 0-6 4-9 14-9s14 3 14 9c0 8-5 15-14 15z" fill={`url(#${id}-h)`} stroke="#4a2610" strokeWidth="1.2" />
          <path d="M9 19c1-6 7-10 15-10s14 4 15 10c-5 2-25 2-30 0z" fill="#6b3d1c" stroke="#3b1f0b" strokeWidth="1.2" />
          <path d="M14 15.5h20M12 18h24" stroke="#9a6236" strokeWidth="1" opacity="0.8" />
          <path d="M24 9V5" stroke="#4a2610" strokeWidth="2.4" strokeLinecap="round" />
          <ellipse cx="18" cy="26" rx="3.2" ry="2" fill="#fff" opacity="0.45" transform="rotate(-30 18 26)" />
        </g>
      );

    case 'star':
    case 'star-empty': {
      const empty = kind === 'star-empty';
      return (
        <g>
          <defs>
            <linearGradient id={`${id}-st`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffe27a" />
              <stop offset="55%" stopColor="#ffb703" />
              <stop offset="100%" stopColor="#e08600" />
            </linearGradient>
          </defs>
          <path
            d={STAR_D}
            fill={empty ? '#ead8cb' : `url(#${id}-st)`}
            stroke={empty ? '#d4bba9' : '#b86b00'}
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          {empty ? null : <path d="M17 18.5 21 16" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.8" />}
        </g>
      );
    }

    case 'striped': {
      const tone = CANDY_TONES[tint ?? 'orange'];
      return (
        <g>
          {candyGradient(id, tone)}
          <defs>
            <clipPath id={`${id}-clip`}>
              <rect x="6" y="12" width="36" height="24" rx="12" />
            </clipPath>
          </defs>
          {SHADOW}
          <rect x="6" y="12" width="36" height="24" rx="12" fill={`url(#${id}-g)`} />
          <g clipPath={`url(#${id}-clip)`} stroke="#fff" strokeOpacity="0.9" strokeWidth="3.4">
            <path d="M12 10 4 38M20 10l-8 28M28 10l-8 28M36 10l-8 28M44 10l-8 28M52 10l-8 28" />
          </g>
          <rect x="6" y="12" width="36" height="24" rx="12" fill="none" stroke={tone.dark} strokeWidth="1.3" />
          <Shine id={id} x={18} y={16.5} rx={8} ry={2.4} rotate={-6} />
        </g>
      );
    }

    case 'wrapped': {
      const tone = CANDY_TONES[tint ?? 'purple'];
      return (
        <g>
          {candyGradient(id, tone)}
          {SHADOW}
          <path d="M11 24 2 15v18zM37 24l9-9v18z" fill={tone.base} stroke={tone.dark} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M5 19l3 2M5 29l3-2M43 19l-3 2M43 29l-3-2" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.2" />
          <circle cx="24" cy="24" r="13.5" fill={`url(#${id}-g)`} stroke={tone.dark} strokeWidth="1.3" />
          <circle cx="24" cy="24" r="9" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.4" strokeDasharray="3 3" />
          <Shine id={id} x={19} y={16} rx={5.6} ry={2.4} />
        </g>
      );
    }

    case 'color-bomb':
      return (
        <g>
          <defs>
            <radialGradient id={`${id}-cb`} cx="36%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#8a5a42" />
              <stop offset="50%" stopColor="#4a2617" />
              <stop offset="100%" stopColor="#1f0d06" />
            </radialGradient>
          </defs>
          {SHADOW}
          <circle cx="24" cy="24.5" r="17.5" fill={`url(#${id}-cb)`} />
          {[
            ['#ff4d6d', 14, 20, 30],
            ['#ffd21f', 22, 13, -20],
            ['#2fc27a', 31, 19, 60],
            ['#2f8bff', 17, 30, -50],
            ['#a24ee6', 27, 27, 15],
            ['#ff8a1f', 33, 31, -70],
            ['#ffffff', 23, 36, 40],
            ['#2fc27a', 12, 25, 80],
          ].map(([c, x, y, r], i) => (
            <rect
              key={i}
              x={(x as number) - 2.6}
              y={(y as number) - 1}
              width="5.2"
              height="2"
              rx="1"
              fill={c as string}
              transform={`rotate(${r as number} ${x as number} ${y as number})`}
            />
          ))}
          <ellipse cx="17.5" cy="14" rx="6" ry="2.6" fill="#fff" opacity="0.35" transform="rotate(-24 17.5 14)" />
        </g>
      );

    case 'hammer':
      return (
        <g>
          <defs>
            <radialGradient id={`${id}-lh`} cx="38%" cy="32%" r="72%">
              <stop offset="0%" stopColor="#ffb3c6" />
              <stop offset="55%" stopColor="#e6396b" />
              <stop offset="100%" stopColor="#9c1240" />
            </radialGradient>
          </defs>
          <path d="M22 24 8.5 41.5" stroke="#8b5a3c" strokeWidth="5" strokeLinecap="round" />
          <path d="M22 24 8.5 41.5" stroke="#f3d3b4" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 4" />
          <circle cx="29" cy="17" r="13" fill={`url(#${id}-lh)`} stroke="#8e1038" strokeWidth="1.2" />
          <path
            d="M29 17c0-1.6 2-2.2 3.2-1 1.8 1.9-.3 5.1-3.2 5.1-4 0-5.9-4.5-3.7-7.8 2.7-4 9.1-3.7 11.4 1"
            fill="none"
            stroke="#fff"
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.9"
          />
          <ellipse cx="23.5" cy="10.5" rx="4" ry="1.8" fill="#fff" opacity="0.7" transform="rotate(-30 23.5 10.5)" />
        </g>
      );

    case 'free-switch':
      return (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13" cy="24" r="8" fill="#2f8bff" stroke="#1349b0" strokeWidth="1.2" />
          <circle cx="35" cy="24" r="8" fill="#ffd01f" stroke="#c78f00" strokeWidth="1.2" />
          <ellipse cx="10.5" cy="20.5" rx="2.6" ry="1.4" fill="#fff" opacity="0.8" />
          <ellipse cx="32.5" cy="20.5" rx="2.6" ry="1.4" fill="#fff" opacity="0.8" />
          <path d="M14 11c5-5 15-5 20 0" stroke="currentColor" strokeWidth="3.2" />
          <path d="m30 6.5 4.5 4.5-5.5 2" stroke="currentColor" strokeWidth="3.2" />
          <path d="M34 37c-5 5-15 5-20 0" stroke="currentColor" strokeWidth="3.2" />
          <path d="m18 41.5-4.5-4.5 5.5-2" stroke="currentColor" strokeWidth="3.2" />
        </g>
      );

    case 'shuffle':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 14h7c9 0 13 20 22 20h6" />
          <path d="M6 34h7c3.6 0 6.2-3.2 8.4-7M27 21c2.2-3.8 4.6-7 8-7h6" />
          <path d="m37 9 5 5-5 5M37 29l5 5-5 5" />
        </g>
      );

    case 'sound':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 19v10h7l10 8V11l-10 8z" fill="currentColor" fillOpacity="0.18" />
          <path d="M31 18c2 1.6 3 3.6 3 6s-1 4.4-3 6M36 13c3.6 3 5.4 6.6 5.4 11S39.6 32 36 35" />
        </g>
      );

    case 'music':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 35V11l20-4v24" />
          <circle cx="13" cy="35" r="5" fill="currentColor" fillOpacity="0.18" />
          <circle cx="33" cy="31" r="5" fill="currentColor" fillOpacity="0.18" />
          <path d="M18 17l20-4" />
        </g>
      );

    case 'settings':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M24 6.5l3 4.2 5-1.4 1 5.1 5 1.3-1.4 5 4.2 3.3-4.2 3.3 1.4 5-5 1.3-1 5.1-5-1.4-3 4.2-3-4.2-5 1.4-1-5.1-5-1.3 1.4-5L5.2 24l4.2-3.3-1.4-5 5-1.3 1-5.1 5 1.4z" />
          <circle cx="24" cy="24" r="6.2" fill="currentColor" fillOpacity="0.18" />
        </g>
      );

    case 'map':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 11.5 17 7l14 5 11-4.5v29L31 41l-14-5-11 4.5z" />
          <path d="M17 7v29M31 12v29" />
        </g>
      );

    case 'retry':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M38.5 24A14.5 14.5 0 1 1 33.8 13.3" />
          <path d="M35.5 5.5v9h-9" />
        </g>
      );

    case 'lock':
      return (
        <g strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-5a8 8 0 0 1 16 0v5" fill="none" stroke="currentColor" strokeWidth="3.4" />
          <rect x="10" y="20" width="28" height="21" rx="6" fill="currentColor" />
          <circle cx="24" cy="29.5" r="2.6" fill="#fff" opacity="0.9" />
          <path d="M24 31v4" stroke="#fff" strokeWidth="2.4" opacity="0.9" />
        </g>
      );

    case 'check':
      return <path d="M11 25.5 20 34l17-19" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />;

    case 'close':
      return <path d="M14 14l20 20M34 14 14 34" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />;

    case 'share':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 19h-4v22h24V19h-4" />
          <path d="M24 30V6M16.5 13 24 5.5l7.5 7.5" />
        </g>
      );

    case 'add-square':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="7" width="34" height="34" rx="9" />
          <path d="M24 16v16M16 24h16" />
        </g>
      );

    case 'play':
      return <path d="M17 11.5v25c0 1.6 1.8 2.6 3.2 1.7l19-12.5a2 2 0 0 0 0-3.4l-19-12.5c-1.4-.9-3.2.1-3.2 1.7z" fill="currentColor" />;

    case 'gift':
      return (
        <g strokeLinejoin="round">
          <rect x="8" y="19" width="32" height="22" rx="4" fill="#e6396b" stroke="#9c1240" strokeWidth="1.2" />
          <rect x="6" y="13" width="36" height="8" rx="3" fill="#ff6f95" stroke="#9c1240" strokeWidth="1.2" />
          <path d="M24 13v28" stroke="#ffb703" strokeWidth="5" />
          <path d="M24 13c-3-6-11-8-11-3 0 3 6 3 11 3zM24 13c3-6 11-8 11-3 0 3-6 3-11 3z" fill="#ffb703" stroke="#b86b00" strokeWidth="1.2" />
        </g>
      );

    /* Homing Sugar Bee: glossy candy body, cocoa stripes, frosted wings. */
    case 'seeker': {
      const tone = CANDY_TONES[tint ?? 'yellow'];
      return (
        <g strokeLinejoin="round" strokeLinecap="round">
          {candyGradient(id, tone)}
          <defs>
            <clipPath id={`${id}-bee`}>
              <ellipse cx="22.5" cy="29" rx="14.5" ry="11" />
            </clipPath>
            <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
              <stop offset="100%" stopColor="#cdeaff" stopOpacity="0.85" />
            </linearGradient>
          </defs>
          {SHADOW}
          <ellipse cx="17" cy="14.5" rx="6.4" ry="9" fill={`url(#${id}-wing)`} stroke="#7fbde8" strokeWidth="1.2" transform="rotate(-28 17 14.5)" />
          <ellipse cx="27" cy="13.5" rx="6.4" ry="9" fill={`url(#${id}-wing)`} stroke="#7fbde8" strokeWidth="1.2" transform="rotate(22 27 13.5)" />
          <path d="M17.5 10.5c-.4 2.6.2 5 1.6 7M26.6 9.6c.8 2.4.6 4.9-.6 7" fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="1.1" />
          <path d="M8.6 28.2 3.2 29.6l5.6 2.2z" fill="#3b2318" />
          <ellipse cx="22.5" cy="29" rx="14.5" ry="11" fill={`url(#${id}-g)`} />
          <g clipPath={`url(#${id}-bee)`} stroke="#3b2318" strokeWidth="3.6">
            <path d="M15.5 16v26M22.5 16v26" />
          </g>
          <ellipse cx="22.5" cy="29" rx="14.5" ry="11" fill="none" stroke={tone.dark} strokeWidth="1.3" />
          <path d="M33 20.5c1.2-4 3.4-6.4 6.4-7.2M35.6 22c2.2-3 4.8-4.4 7.6-4.2" fill="none" stroke="#3b2318" strokeWidth="1.5" />
          <circle cx="39.6" cy="13.2" r="1.9" fill={tone.base} stroke="#3b2318" strokeWidth="1" />
          <circle cx="43.2" cy="17.8" r="1.9" fill={tone.base} stroke="#3b2318" strokeWidth="1" />
          <circle cx="31" cy="26.4" r="2.6" fill="#3b2318" />
          <circle cx="31.9" cy="25.5" r="0.9" fill="#fff" />
          <path d="M29.4 32.2c1.4 1.4 3.4 1.4 4.8 0" fill="none" stroke="#3b2318" strokeWidth="1.3" />
          <ellipse cx="35.2" cy="30.4" rx="1.8" ry="1.1" fill="#ff8fb0" opacity="0.75" />
          <Shine id={id} x={24} y={21.4} rx={6.4} ry={2.2} rotate={-8} />
        </g>
      );
    }

    /* Endless Zen: glossy mint ribbon lemniscate. */
    case 'infinity':
      return (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <defs>
            <linearGradient id={`${id}-inf`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#7ff0c0" />
              <stop offset="50%" stopColor="#21b97a" />
              <stop offset="100%" stopColor="#0f7a4f" />
            </linearGradient>
          </defs>
          <path
            d="M24 24c-3.8-4.6-7.4-7.6-11.4-7.6a7.6 7.6 0 0 0 0 15.2c4 0 7.6-3 11.4-7.6zm0 0c3.8 4.6 7.4 7.6 11.4 7.6a7.6 7.6 0 0 0 0-15.2c-4 0-7.6 3-11.4 7.6z"
            stroke="#0b5a3a"
            strokeOpacity="0.35"
            strokeWidth="7.4"
            transform="translate(0 1.4)"
          />
          <path
            d="M24 24c-3.8-4.6-7.4-7.6-11.4-7.6a7.6 7.6 0 0 0 0 15.2c4 0 7.6-3 11.4-7.6zm0 0c3.8 4.6 7.4 7.6 11.4 7.6a7.6 7.6 0 0 0 0-15.2c-4 0-7.6 3-11.4 7.6z"
            stroke={`url(#${id}-inf)`}
            strokeWidth="6"
          />
          <path d="M9.4 21.4c1-1.8 2.6-2.8 4.4-2.8M34.2 18.6c1.8 0 3.4.8 4.4 2.4" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.8" />
        </g>
      );

    /* Win streak: warm honey flame. */
    case 'flame':
      return (
        <g strokeLinejoin="round">
          <defs>
            <linearGradient id={`${id}-fl`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffe48a" />
              <stop offset="45%" stopColor="#ffb703" />
              <stop offset="100%" stopColor="#ef6a1a" />
            </linearGradient>
          </defs>
          <path
            d="M24 4.5c1.6 6.4 9.6 10.4 11.6 18.2 2.2 8.8-3.6 18.8-11.6 18.8S10.2 34.4 12 26.4c1-4.4 3.8-6.4 4.8-10 1.6 2.8 2.6 4.6 4.6 5.6C20.4 15.6 21.6 9.8 24 4.5z"
            fill={`url(#${id}-fl)`}
            stroke="#b86b00"
            strokeWidth="1.4"
          />
          <path d="M24 22c3.6 3.6 6.4 6.8 5.4 11-1 3.6-3.4 5-5.4 5s-4.6-1.6-5.2-4.6c-.6-3.2 1.6-5 3-6.6.4 1.4 1.2 2.2 2 2.4-.6-2.6-.4-4.8.2-7.2z" fill="#fff4c2" />
          <ellipse cx="19.4" cy="21" rx="2" ry="4.2" fill="#fff" opacity="0.55" transform="rotate(18 19.4 21)" />
        </g>
      );
  }
}
