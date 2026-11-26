import { ALL_CANDY_COLORS } from '../engine/types'
import type {
  CandyColor, IngredientSpawnRule, IngredientType, LevelDef, ObjectiveTarget, SpecialType,
} from '../engine/types'

type LevelOptions = Pick<LevelDef, 'ingredientSpawns' | 'tutorialHint'>

function level(
  id: number, name: string, subtitle: string, colorCount: number, moves: number,
  starThresholds: LevelDef['starThresholds'], objectives: ObjectiveTarget[], layout: string[],
  options: LevelOptions = {},
): LevelDef {
  return {
    id, chapterId: Math.ceil(id / 5), name, subtitle, rows: layout.length, cols: layout[0].length,
    colors: ALL_CANDY_COLORS.slice(0, colorCount), moves, starThresholds, objectives, layout, ...options,
  }
}

const score = (target: number): ObjectiveTarget => ({ id: 'score', kind: 'score', label: 'Score', target })
const jelly = (target: number): ObjectiveTarget => ({ id: 'jelly', kind: 'jelly', label: 'Jelly', target })
const colorOrder = (color: CandyColor, target: number): ObjectiveTarget => ({
  id: color, kind: 'order', color, target, label: color[0].toUpperCase() + color.slice(1),
})
const specialOrder = (special: SpecialType, label: string, target: number): ObjectiveTarget => ({
  id: special, kind: 'order', special, label, target,
})
const ingredients = (ingredient: IngredientType, target: number): ObjectiveTarget => ({
  id: ingredient, kind: 'ingredients', ingredient, target,
  label: ingredient === 'cherry' ? 'Cherries' : 'Hazelnuts',
})
const spawn = (type: IngredientType, count: number, spawnCols: number[]): IngredientSpawnRule => ({
  type, count, spawnCols, maxOnBoard: 1,
})

export const LEVELS: LevelDef[] = [
  // Sugar Meadow
  level(1, 'First Pick', 'A strawberry picnic', 4, 20, [800, 2000, 4000],
    [score(800)], [
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
    ], { tutorialHint: 'Swap neighboring candies to make a line of three. Match four in a line to make a striped candy.' }),
  level(2, 'Ribbon Candy', 'Stripes across the meadow', 4, 22, [1000, 2500, 5000],
    [colorOrder('red', 22)], [
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
    ], { tutorialHint: 'Match a striped candy to clear its whole row or column. Look at the stripe direction before you swap.' }),
  level(3, 'Picnic Parcel', 'A sweet with a surprise inside', 4, 23, [1200, 2900, 5700],
    [score(1200), colorOrder('yellow', 18)], [
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
    ], { tutorialHint: 'Join two matches in an L or T shape to make a wrapped candy. Match it to blast nearby tiles twice.' }),
  level(4, 'Sugar Comet', 'A trail of rainbow sugar', 5, 24, [1300, 3200, 6100],
    [score(1300), colorOrder('blue', 18)], [
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ], { tutorialHint: 'Match five in a straight line to make a color bomb. Swap it with any ordinary candy to clear that color.' }),
  level(5, 'Picnic Finale', 'Two sweets in one swap', 5, 25, [1600, 3600, 6800],
    [score(1600), colorOrder('red', 24), colorOrder('orange', 22)], [
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
    ], { tutorialHint: 'Swap two neighboring special candies to combine their powers. Try a striped candy with a wrapped candy to clear three rows and three columns.' }),

  // Jelly Gardens
  level(6, 'Jelly Bed', 'Glaze beneath the flowers', 4, 20, [1200, 3000, 5800],
    [jelly(16)], [
      '.......',
      '..jj...',
      '.jjjj..',
      '.jjjj..',
      '..jjjj.',
      '...jj..',
      '.......',
    ], { tutorialHint: 'Clear the candy on a jelly tile to take off a layer. Double jelly takes two clears.' }),
  level(7, 'Glazed Diamond', 'A berry at each point', 4, 24, [1500, 3600, 6900],
    [jelly(21)], [
      '##...##',
      '#..j..#',
      '..jJj..',
      '.jJJJj.',
      '..jJj..',
      '#.jjj.#',
      '##.j.##',
    ]),
  level(8, 'Mint Bridge', 'Across the berry brook', 4, 25, [1800, 4100, 7600],
    [jelly(28)], [
      '...###...',
      '.j.###.j.',
      '.J.###.J.',
      '.jjJJJjj.',
      '.J.###.J.',
      '.j.###.j.',
      'jj.###.jj',
      '.j.###.j.',
    ]),
  level(9, 'Twin Islands', 'Two banks of berry glaze', 4, 26, [2000, 4500, 8200],
    [jelly(28)], [
      '....#....',
      '.jj.#.jj.',
      '.JJ.#.JJ.',
      '.jj.#.jj.',
      '..J.#.J..',
      '.jJ.#.Jj.',
      '....#....',
      '.j..#..j.',
    ]),
  level(10, 'Glasshouse', 'A glazed frame around the courtyard', 4, 28, [2400, 5000, 9000],
    [jelly(32)], [
      '..jjjj..',
      '.J....J.',
      'j..##..j',
      'j..##..j',
      'J..##..J',
      'j..##..j',
      '.J....J.',
      '.jJJJJj.',
    ]),

  // Frosting Peaks
  level(11, 'Vanilla Flurry', 'The first snow on the trail', 4, 21, [1300, 3200, 6200],
    [colorOrder('orange', 28)], [
      '.......',
      '.......',
      '.......',
      '..1.1..',
      '.1...1.',
      '..111..',
      '.......',
    ], { tutorialHint: 'Match beside frosting or hit it with a special candy to chip off a layer.' }),
  level(12, 'Icing Ledges', 'Two layers deep', 5, 25, [1800, 4200, 7800],
    [colorOrder('red', 24), colorOrder('green', 24)], [
      '........',
      '........',
      '.11..11.',
      '..2..2..',
      '........',
      '.2.11.2.',
      '..2..2..',
      '........',
    ]),
  level(13, 'Ribbon Run', 'Horizontal stripes across the ridge', 4, 28, [2100, 4800, 8600],
    [specialOrder('striped-h', 'Horizontal striped candies', 1), colorOrder('red', 26)], [
      '.........',
      '.........',
      '...111...',
      '.2.....2.',
      '.2..3..2.',
      '...121...',
      '.1.....1.',
      '.........',
    ], { tutorialHint: 'Make a horizontal striped candy and use it to sweep across an icing ledge.' }),
  level(14, 'Wrapped Summit', 'A parcel for the climb', 4, 29, [2200, 5100, 9200],
    [specialOrder('wrapped', 'Wrapped candies', 1), colorOrder('yellow', 30)], [
      '.........',
      '.........',
      '..1...1..',
      '.2..3..2.',
      '...323...',
      '.1.....1.',
      '..2...2..',
      '.........',
      '.........',
    ]),
  level(15, 'The Sugar Ridge', 'A triple-layer icing crest', 4, 30, [2500, 5600, 9900],
    [specialOrder('wrapped', 'Wrapped candies', 1), colorOrder('red', 32), colorOrder('green', 32)], [
      '.........',
      '.........',
      '.11...11.',
      '..2...2..',
      '...333...',
      '..2...2..',
      '.11...11.',
      '.........',
      '.........',
    ]),

  // Berry Orchard
  level(16, 'Cherry Chute', 'The first ripe cherry', 4, 22, [1300, 3400, 6500],
    [ingredients('cherry', 1)], [
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '...E...',
    ], { ingredientSpawns: [spawn('cherry', 1, [3])],
      tutorialHint: 'Clear candies below an ingredient to drop it to a marked exit.' }),
  level(17, 'Hazelnut Hollow', 'Two paths to the baskets', 4, 24, [1600, 4000, 7500],
    [ingredients('hazelnut', 2)], [
      '........',
      '........',
      '...LL...',
      '.L....L.',
      '....L...',
      '...L....',
      '........',
      '..E..E..',
    ], { ingredientSpawns: [spawn('hazelnut', 2, [2, 5])],
      tutorialHint: 'Match a licorice-locked candy in place to break its lock.' }),
  level(18, 'Paired Baskets', 'Cherries and hazelnuts together', 4, 26, [1800, 4300, 8000],
    [ingredients('cherry', 1), ingredients('hazelnut', 1)], [
      '.........',
      '.........',
      '..L...L..',
      '...L.L...',
      '.L.....L.',
      '..L...L..',
      '....L....',
      '.........',
      '..E...E..',
    ], { ingredientSpawns: [spawn('cherry', 1, [2]), spawn('hazelnut', 1, [6])] }),
  level(19, 'Orchard Glaze', 'A jelly lining in the baskets', 4, 28, [2000, 4700, 8600],
    [ingredients('cherry', 2), jelly(14)], [
      '.........',
      '.........',
      '...LLL...',
      '..j...j..',
      '.jj.L.jj.',
      '..j.L.j..',
      '...jjj...',
      '....j....',
      '..e...e..',
    ], { ingredientSpawns: [spawn('cherry', 2, [2, 6])] }),
  level(20, 'Harvest Gate', 'Three treats through licorice', 4, 30, [2400, 5300, 9600],
    [ingredients('cherry', 2), ingredients('hazelnut', 1), colorOrder('orange', 24)], [
      '.........',
      '.........',
      '..L.L.L..',
      '.L.....L.',
      '..L...L..',
      '...L.L...',
      '.L..L..L.',
      '.........',
      '..E.E.E..',
    ], { ingredientSpawns: [spawn('cherry', 2, [2, 6]), spawn('hazelnut', 1, [4])] }),

  // Truffle Palace
  level(21, 'Cocoa Foyer', 'A quiet corner of chocolate', 4, 22, [1500, 3700, 7000],
    [colorOrder('red', 24), score(1500)], [
      '........',
      '........',
      '........',
      '........',
      '........',
      '.C......',
      '.C......',
      '........',
    ], { tutorialHint: 'Chocolate spreads on turns when you clear none. Match beside it or hit it with a special candy.' }),
  level(22, 'Ganache Gallery', 'Berry glaze between cocoa walls', 4, 27, [2000, 4800, 8600],
    [jelly(23)], [
      '.........',
      '.........',
      '...jjj...',
      '.C.jJj.C.',
      '.C.jJj.C.',
      '...jJj...',
      '..jjjjj..',
      '...jjj...',
    ]),
  level(23, 'Caramel Court', 'A wrapped sweet for the royal order', 4, 29, [2300, 5400, 9500],
    [specialOrder('wrapped', 'Wrapped candies', 1), colorOrder('orange', 32)], [
      '.........',
      '.........',
      '.1.....1.',
      '...2.2...',
      '.C..3..C.',
      '..C...C..',
      '.1.....1.',
      '....L....',
      '.........',
    ]),
  level(24, 'Crowned Cherry', 'A cherry through the truffle hall', 4, 30, [2600, 5900, 10400],
    [ingredients('cherry', 2), jelly(21)], [
      '.........',
      '.........',
      '...1.1...',
      '.C.jjj.C.',
      '.C.jJj.C.',
      '..j.L.j..',
      '..jJJJj..',
      '...j.j...',
      '..e...e..',
    ], { ingredientSpawns: [spawn('cherry', 2, [2, 6])] }),
  level(25, 'The Gilded Truffle', 'The chocolatier’s final course', 4, 32, [3000, 6800, 12000],
    [jelly(30), ingredients('hazelnut', 2), colorOrder('red', 34)], [
      '.........',
      '.........',
      '..j111j..',
      '.C.jjj.C.',
      '..jJLJj..',
      '.C.jJj.C.',
      '..jJjJj..',
      '.jJ...Jj.',
      '..e...e..',
    ], { ingredientSpawns: [spawn('hazelnut', 2, [2, 6])] }),
]

export function getLevelById(id: number): LevelDef {
  const definition = LEVELS[id - 1]
  if (!definition || definition.id !== id) throw new RangeError(`Unknown level: ${id}`)
  return definition
}
