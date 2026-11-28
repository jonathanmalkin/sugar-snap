import type { MusicSelection } from '../audio/soundTypes'
import { ALL_CANDY_COLORS } from '../engine/types'
import type { BoosterType, Cell, SpecialType } from '../engine/types'
import { LEVELS } from '../levels/levels'
import { ZEN_LEVEL } from '../levels/zen'
import type { LevelProgress, PlayerSave, UserSettings, ZenSaveState } from './storageTypes'

export const STORAGE_KEY = 'sugarsnap_save_v1'

export const DEFAULT_SETTINGS: UserSettings = {
  sfxEnabled: true,
  musicEnabled: true,
  sfxVolume: 0.75,
  musicVolume: 0.45,
  musicTrack: 'auto',
  colorblindMode: false,
  reducedMotion: false,
}

const BOOSTER_ROTATION: readonly BoosterType[] = ['hammer', 'free-switch', 'shuffle']
const STARS_PER_BOOSTER = 6

export function createDefaultSave(): PlayerSave {
  return {
    highestUnlockedLevel: 1,
    levels: {},
    boosters: { hammer: 2, 'free-switch': 2, shuffle: 2 },
    totalStarsClaimedForBoosters: 0,
    winStreak: 0,
    zenBestScore: 0,
    zenBestCascade: 0,
    zenState: null,
    settings: { ...DEFAULT_SETTINGS },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nonnegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : fallback
}

function starCount(value: unknown): LevelProgress['stars'] {
  return value === 1 || value === 2 || value === 3 ? value : 0
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function volumeSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

const VALID_MUSIC_SELECTIONS: readonly MusicSelection[] = ['auto', 'funk', 'bossa', 'lounge', 'lofi']

function musicTrackSetting(value: unknown, fallback: MusicSelection): MusicSelection {
  return typeof value === 'string' && VALID_MUSIC_SELECTIONS.some((t) => t === value)
    ? (value as MusicSelection)
    : fallback
}

function mergeSettings(value: unknown, base: UserSettings): UserSettings {
  const settings = asRecord(value)
  return {
    sfxEnabled: booleanSetting(settings.sfxEnabled, base.sfxEnabled),
    musicEnabled: booleanSetting(settings.musicEnabled, base.musicEnabled),
    sfxVolume: volumeSetting(settings.sfxVolume, base.sfxVolume),
    musicVolume: volumeSetting(settings.musicVolume, base.musicVolume),
    musicTrack: musicTrackSetting(settings.musicTrack, base.musicTrack),
    colorblindMode: booleanSetting(settings.colorblindMode, base.colorblindMode),
    reducedMotion: booleanSetting(settings.reducedMotion, base.reducedMotion),
  }
}

const SPECIALS: readonly SpecialType[] = ['none', 'striped-h', 'striped-v', 'wrapped', 'color-bomb', 'seeker']

function isZenCell(value: unknown, row: number, col: number): value is Cell {
  const cell = asRecord(value)
  if (cell.row !== row || cell.col !== col
    || typeof cell.playable !== 'boolean' || typeof cell.locked !== 'boolean'
    || typeof cell.chocolate !== 'boolean' || typeof cell.isExit !== 'boolean'
    || ![0, 1, 2].some((n) => n === cell.jelly) || ![0, 1, 2, 3].some((n) => n === cell.frosting)) return false
  if (cell.candy === null) return true
  const candy = asRecord(cell.candy)
  return nonnegativeInteger(candy.id) === candy.id && candy.id > 0
    && (candy.color === 'none' || ALL_CANDY_COLORS.some((color) => color === candy.color))
    && SPECIALS.some((special) => special === candy.special)
    && (candy.ingredient === undefined || candy.ingredient === 'cherry' || candy.ingredient === 'hazelnut')
}

function parseZenState(value: unknown): ZenSaveState | null {
  const zen = asRecord(value)
  const grid: unknown = zen.grid
  if (!Array.isArray(grid) || grid.length !== ZEN_LEVEL.rows) return null

  const cells: Cell[][] = []
  const ids = new Set<number>()
  let maxId = 0
  for (const [rowIndex, row] of grid.entries()) {
    if (!Array.isArray(row) || row.length !== ZEN_LEVEL.cols) return null
    const validated: Cell[] = []
    for (const [colIndex, cell] of row.entries()) {
      if (!isZenCell(cell, rowIndex, colIndex)) return null
      if (cell.candy) {
        if (ids.has(cell.candy.id)) return null
        ids.add(cell.candy.id)
        maxId = Math.max(maxId, cell.candy.id)
      }
      validated.push(cell)
    }
    cells.push(validated)
  }

  const nextCandyId = nonnegativeInteger(zen.nextCandyId)
  if (nextCandyId <= maxId) return null
  return {
    grid: cells,
    score: nonnegativeInteger(zen.score),
    maxCascade: nonnegativeInteger(zen.maxCascade),
    totalMovesMade: nonnegativeInteger(zen.totalMovesMade),
    nextCandyId,
  }
}

export function loadSave(): PlayerSave {
  const save = createDefaultSave()
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return save

    const data = asRecord(JSON.parse(raw))
    const storedLevels = asRecord(data.levels)
    const storedBoosters = asRecord(data.boosters)
    save.highestUnlockedLevel = Math.max(1, Math.min(LEVELS.length, nonnegativeInteger(data.highestUnlockedLevel)))
    for (const { id } of LEVELS) {
      const stored = storedLevels[id]
      if (stored === undefined) continue
      const progress = asRecord(stored)
      const stars = starCount(progress.stars)
      const completed = progress.completed === true || stars > 0
      save.levels[id] = { completed, stars, bestScore: nonnegativeInteger(progress.bestScore) }
      if (completed) {
        save.highestUnlockedLevel = Math.max(save.highestUnlockedLevel, Math.min(LEVELS.length, id + 1))
      }
    }
    for (const booster of BOOSTER_ROTATION) {
      save.boosters[booster] = nonnegativeInteger(storedBoosters[booster], save.boosters[booster])
    }
    const maximumClaims = Math.floor(LEVELS.length * 3 / STARS_PER_BOOSTER)
    const claims = Math.floor(nonnegativeInteger(data.totalStarsClaimedForBoosters) / STARS_PER_BOOSTER)
    save.totalStarsClaimedForBoosters = Math.min(maximumClaims, claims) * STARS_PER_BOOSTER
    save.winStreak = nonnegativeInteger(data.winStreak)
    save.zenBestScore = nonnegativeInteger(data.zenBestScore)
    save.zenBestCascade = nonnegativeInteger(data.zenBestCascade)
    save.zenState = parseZenState(data.zenState)
    save.settings = mergeSettings(data.settings, DEFAULT_SETTINGS)
    return save
  } catch {
    return createDefaultSave()
  }
}

export function savePlayerData(save: PlayerSave): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // Play can continue when storage is disabled or full.
  }
}

/**
 * Re-read the latest persisted save before applying a mutation so a stale tab
 * cannot overwrite level unlocks, stars, or booster counts earned in another tab.
 */
export function mutateSave<T>(
  mutator: (latest: PlayerSave) => { save: PlayerSave; result: T },
): { save: PlayerSave; result: T } {
  const latest = loadSave()
  const out = mutator(latest)
  savePlayerData(out.save)
  return out
}

export function getTotalStars(save: PlayerSave): number {
  return Object.values(save.levels).reduce((total, level) => total + level.stars, 0)
}

export function recordLevelCompletion(
  save: PlayerSave, levelId: number, score: number, stars: LevelProgress['stars'],
): { save: PlayerSave; awardedBoosters: BoosterType[] } {
  if (!Number.isInteger(levelId) || levelId < 1 || levelId > LEVELS.length) {
    return { save, awardedBoosters: [] }
  }

  const previous = save.levels[levelId]
  const next: PlayerSave = {
    ...save,
    highestUnlockedLevel: Math.max(save.highestUnlockedLevel, Math.min(levelId + 1, LEVELS.length)),
    levels: {
      ...save.levels,
      [levelId]: {
        completed: true,
        stars: previous && previous.stars > stars ? previous.stars : stars,
        bestScore: Math.max(previous?.bestScore ?? 0, nonnegativeInteger(score)),
      },
    },
    boosters: { ...save.boosters },
    winStreak: save.winStreak + 1,
  }

  const totalStars = getTotalStars(next)
  const awardedBoosters: BoosterType[] = []
  while (next.totalStarsClaimedForBoosters + STARS_PER_BOOSTER <= totalStars) {
    const rewardIndex = Math.floor(next.totalStarsClaimedForBoosters / STARS_PER_BOOSTER)
    const booster = BOOSTER_ROTATION[rewardIndex % BOOSTER_ROTATION.length]
    next.boosters[booster] += 1
    next.totalStarsClaimedForBoosters += STARS_PER_BOOSTER
    awardedBoosters.push(booster)
  }
  return { save: next, awardedBoosters }
}

export function resetWinStreak(save: PlayerSave): PlayerSave {
  return { ...save, winStreak: 0 }
}

export function saveZenSession(save: PlayerSave, zen: ZenSaveState): PlayerSave {
  return {
    ...save,
    zenState: zen,
    zenBestScore: Math.max(save.zenBestScore, zen.score),
    zenBestCascade: Math.max(save.zenBestCascade, zen.maxCascade),
  }
}

export function clearZenSession(save: PlayerSave): PlayerSave {
  return { ...save, zenState: null }
}

export function consumeBooster(save: PlayerSave, booster: BoosterType): PlayerSave {
  if (save.boosters[booster] <= 0) return save
  return { ...save, boosters: { ...save.boosters, [booster]: save.boosters[booster] - 1 } }
}

export function updateUserSettings(save: PlayerSave, partial: Partial<UserSettings>): PlayerSave {
  return { ...save, settings: mergeSettings(partial, save.settings) }
}

export function resetPlayerSave(): PlayerSave {
  const save = createDefaultSave()
  savePlayerData(save)
  return save
}
