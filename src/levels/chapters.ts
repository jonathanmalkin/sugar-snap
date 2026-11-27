import type { ChapterDef } from '../engine/types'

export const CHAPTERS: ChapterDef[] = [
  {
    id: 1, name: 'Sugar Meadow', tagline: 'A picnic of strawberry sweets',
    accentColor: '#a92f56', bgFrom: '#fff6dc', bgTo: '#f7bdca', trayTint: '#652f4d',
    levelIds: [1, 2, 3, 4, 5],
  },
  {
    id: 2, name: 'Jelly Gardens', tagline: 'Berry glaze under the mint leaves',
    accentColor: '#843e78', bgFrom: '#e5f7df', bgTo: '#eab3d9', trayTint: '#553457',
    levelIds: [6, 7, 8, 9, 10],
  },
  {
    id: 3, name: 'Frosting Peaks', tagline: 'A dusting of vanilla snow',
    accentColor: '#51499d', bgFrom: '#fff9ed', bgTo: '#bfc3f5', trayTint: '#3e396b',
    levelIds: [11, 12, 13, 14, 15],
  },
  {
    id: 4, name: 'Donut Orchard', tagline: 'Frosted donuts gliding to the exits',
    accentColor: '#813a68', bgFrom: '#ffdcbd', bgTo: '#cc9bc5', trayTint: '#59334f',
    levelIds: [16, 17, 18, 19, 20],
  },
  {
    id: 5, name: 'Truffle Palace', tagline: 'The chocolatier’s final course',
    accentColor: '#88431f', bgFrom: '#ffdea0', bgTo: '#cb8e71', trayTint: '#492b32',
    levelIds: [21, 22, 23, 24, 25],
  },
]

export function getChapterById(id: number): ChapterDef {
  const chapter = CHAPTERS[id - 1]
  if (!chapter || chapter.id !== id) throw new RangeError(`Unknown chapter: ${id}`)
  return chapter
}
