import type { ChapterDef, LevelDef } from '../engine/types'

export const ZEN_CHAPTER: ChapterDef = {
  id: 0,
  name: 'Zen Meadow',
  tagline: 'No moves, no timers — just pure flow',
  accentColor: '#735497',
  bgFrom: '#ffead6',
  bgTo: '#d5c8f1',
  trayTint: '#b8764c',
  levelIds: [0],
}

export const ZEN_LEVEL: LevelDef = {
  id: 0,
  chapterId: 0,
  mode: 'zen',
  name: 'Endless Zen',
  subtitle: 'Match forever at your own pace',
  rows: 8,
  cols: 8,
  colors: ['red', 'orange', 'yellow', 'green', 'blue'],
  moves: 999,
  starThresholds: [5000, 15000, 35000],
  objectives: [],
  layout: Array.from({ length: 8 }, () => '........'),
}
