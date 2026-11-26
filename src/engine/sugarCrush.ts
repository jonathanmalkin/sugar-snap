import type { AnimationEvent, GameState, GridPos, PraiseWord, StepResult } from './types';
import { calculateStars, getCell, isRegularCandy } from './board';
import {
  SCORE_VALUES,
  createResolveContext,
  createWave,
  damageCell,
  pushPhase,
  runActivationQueue,
  settleBoard,
} from './resolver';

/** Finale callout for Sugar Snap's bonus cascade. */
const FINALE_CALLOUT: PraiseWord | null = 'Sugar Snap!';

/**
 * End-of-level bonus: every move left becomes a comet that turns a random regular
 * candy striped (+1500), then every special on the board detonates until it settles.
 */
export function executeSugarCrush(state: GameState, rng: () => number = Math.random): StepResult {
  if (state.level.mode === 'zen' || state.status === 'lost') {
    return { valid: false, state, phases: [], starsEarned: calculateStars(state.score, state.level.starThresholds), didShuffle: false };
  }
  const ctx = createResolveContext(state, rng);
  const s = ctx.s;
  const comets: AnimationEvent[] = [];
  while (s.movesLeft > 0) {
    s.movesLeft -= 1;
    s.score += SCORE_VALUES.comet;
    const candidates: GridPos[] = [];
    for (const row of s.grid)
      for (const cell of row)
        if (cell.playable && !cell.locked && isRegularCandy(cell.candy)) candidates.push({ row: cell.row, col: cell.col });
    if (!candidates.length) continue;
    const pos = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
    const candy = getCell(s.grid, pos)!.candy!;
    candy.special = rng() < 0.5 ? 'striped-h' : 'striped-v';
    comets.push({ type: 'sugar-crush-comet', to: pos, candy: { ...candy } });
  }
  if (comets.length) pushPhase(ctx, 'sugar-crush', comets);

  for (let round = 0; round < 100; round++) {
    const specials: GridPos[] = [];
    for (const row of s.grid)
      for (const cell of row)
        if (cell.playable && cell.candy && !cell.candy.ingredient && cell.candy.special !== 'none')
          specials.push({ row: cell.row, col: cell.col });
    if (!specials.length) break;
    const events: AnimationEvent[] = [];
    const wave = createWave(events);
    specials.forEach((p) => damageCell(ctx, wave, p, 'blast'));
    runActivationQueue(ctx, wave);
    pushPhase(ctx, 'sugar-crush', events);
    settleBoard(ctx, 0);
  }

  if (FINALE_CALLOUT) pushPhase(ctx, 'sugar-crush', [{ type: 'callout', text: FINALE_CALLOUT, cascade: 0 }]);
  s.status = 'won';
  s.maxCascade = Math.max(s.maxCascade, ctx.maxCascade);
  return { valid: true, state: s, phases: ctx.phases, starsEarned: calculateStars(s.score, s.level.starThresholds), didShuffle: false };
}
