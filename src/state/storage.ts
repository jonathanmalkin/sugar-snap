import type { BoosterType } from '../engine/types'
import { LEVELS } from '../levels/levels'
import type { LevelProgress, PlayerSave, UserSettings } from './storageTypes'

export const STORAGE_KEY = 'sugarsnap_save_v1'

export const DEFAULT_SETTINGS: UserSettings = {
  sfxEnabled: true,
  musicEnabled: true,
  sfxVolume: 0.75,
  musicVolume: 0.4,
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

function mergeSettings(value: unknown, base: UserSettings): UserSettings {
  const settings = asRecord(value)
  return {
    sfxEnabled: booleanSetting(settings.sfxEnabled, base.sfxEnabled),
    musicEnabled: booleanSetting(settings.musicEnabled, base.musicEnabled),
    sfxVolume: volumeSetting(settings.sfxVolume, base.sfxVolume),
    musicVolume: volumeSetting(settings.musicVolume, base.musicVolume),
    colorblindMode: booleanSetting(settings.colorblindMode, base.colorblindMode),
    reducedMotion: booleanSetting(settings.reducedMotion, base.reducedMotion),
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
