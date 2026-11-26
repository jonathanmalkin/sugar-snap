import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const publicDir = new URL('../public/', import.meta.url)
const iconDir = new URL('icons/', publicDir)
mkdirSync(iconDir, { recursive: true })

const lerp = (a, b, t) => a + (b - a) * t
const clamp = t => Math.min(1, Math.max(0, t))
const mix = (a, b, t) => a.map((channel, index) => lerp(channel, b[index], clamp(t)))
const glow = (x, y, cx, cy, rx, ry) => Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2))

// The artwork lives on a 100-unit canvas. The same paths drive the SVG and PNGs.
const center = [50, 49]
const vertices = Array.from({ length: 10 }, (_, i) => {
  const theta = (i * 36 - 90) * Math.PI / 180
  const radius = i % 2 === 0 ? 36.8 : 21
  return [center[0] + radius * Math.cos(theta), center[1] + radius * Math.sin(theta)]
})
const between = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
const star = vertices.flatMap((vertex, i) => {
  const entry = between(vertex, vertices[(i + 9) % 10], 0.22)
  const exit = between(vertex, vertices[(i + 1) % 10], 0.22)
  return [
    [i === 0 ? 'M' : 'L', ...entry],
    ['Q', ...vertex, ...exit],
  ]
})

const ribbon = [
  ['M', 25, 58],
  ['C', 33, 64, 51, 65, 61, 58],
  ['C', 71, 51, 66, 41, 57, 40],
  ['C', 48, 38, 44, 43, 47, 48],
  ['C', 49, 51, 54, 52, 57, 49],
  ['C', 57, 54, 51, 57, 45, 54],
  ['C', 38, 51, 38, 44, 42, 39],
  ['C', 48, 31, 59, 32, 67, 36],
  ['C', 76, 40, 80, 52, 73, 61],
  ['C', 65, 72, 44, 76, 28, 68],
  ['L', 25, 58],
]

function scaleStar(scale, offsetY = 0) {
  return star.map(([command, ...coords]) => [
    command, ...coords.map((value, i) => lerp(center[i % 2], value, scale) + (i % 2 ? offsetY : 0)),
  ])
}

function flattenPath(commands) {
  const points = []
  for (const [command, ...coords] of commands) {
    const last = points.at(-1)
    if (command === 'M' || command === 'L') {
      points.push(coords)
      continue
    }
    const controls = [last, ...Array.from({ length: coords.length / 2 }, (_, i) => coords.slice(i * 2, i * 2 + 2))]
    for (let step = 1; step <= 12; step++) {
      let segment = controls
      while (segment.length > 1) {
        segment = segment.slice(1).map((point, i) => between(segment[i], point, step / 12))
      }
      points.push(segment[0])
    }
  }
  return points
}

function crossings(points, y) {
  return points.flatMap(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length]
    return (y1 > y) === (y2 > y) ? [] : [lerp(x1, x2, (y - y1) / (y2 - y1))]
  })
}

const contains = (edges, x) => edges.reduce((inside, edge) => x < edge ? !inside : inside, false)
const pathString = commands => commands.map(([command, ...coords]) =>
  command + coords.map(value => +value.toFixed(2)).join(' ')).join(' ') + ' Z'

const backing = scaleStar(1.02, 2.2)
const face = scaleStar(0.925)
const candyPaths = [backing, star, face, ribbon].map(flattenPath)
const sparkles = [
  [79, 25, 3.4], [20, 33, 2.1], [80, 75, 2.6],
]

function paint(x, y, edges) {
  const corner = Math.hypot(Math.max(0, Math.abs(x - 50) - 28), Math.max(0, Math.abs(y - 50) - 28))
  if (corner > 22) return null

  let color = mix([255, 246, 216], [244, 151, 113], (x * 0.19 + y * 0.81) / 100)
  color = mix(color, [255, 255, 238], 0.72 * glow(x, y, 29, 18, 55, 44))
  color = mix(color, [177, 65, 76], 0.32 * glow(x, y, 51, 77, 31, 11))
  const [baseEdge, rimEdge, faceEdge, swirlEdge] = edges

  if (contains(baseEdge, x)) color = mix([167, 55, 38], [115, 22, 46], y / 100)
  if (contains(rimEdge, x)) color = mix([255, 227, 146], [213, 118, 45], (y - 20) / 66)
  if (contains(faceEdge, x)) {
    color = mix([238, 64, 98], [151, 15, 61], (y - 18) / 66)
    color = mix(color, [255, 129, 128], 0.85 * glow(x, y, 43, 33, 22, 16))
    if (contains(swirlEdge, x)) {
      color = mix([255, 244, 180], [246, 135, 57], (y - 34) / 42)
      color = mix(color, [255, 247, 202], 0.63 * glow(x, y, 61, 47, 21, 10))
    }
    const lean = y - 34 + 0.55 * (x - 44)
    color = mix(color, [255, 244, 216], 0.87 * glow(x, lean, 43, 0, 8, 1.45))
    color = mix(color, [255, 249, 227], 0.95 * glow(x, y, 38.6, 37.1, 1.15, 1.15))
  }

  for (const [cx, cy, radius] of sparkles) {
    const dx = Math.abs(cx - x) / radius
    const dy = Math.abs(cy - y) / radius
    if (dx + dy <= 1 && Math.min(dx, dy) < 0.21 * (1 - Math.max(dx, dy))) {
      color = mix(color, [255, 255, 229], 0.93)
    }
  }

  return color
}

const crcTable = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc
})

function chunk(name, payload) {
  const type = Buffer.from(name, 'ascii')
  let crc = 0xffffffff
  for (const bytes of [type, payload]) {
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, type, payload, checksum])
}

function encodeIcon(size) {
  const samples = 3
  const rowWidth = size * 4 + 1
  const pixels = Buffer.alloc(size * rowWidth)

  for (let row = 0; row < size; row++) {
    const rows = Array.from({ length: samples }, (_, subRow) => {
      const y = (row + (subRow + 0.5) / samples) * 100 / size
      return { y, edges: candyPaths.map(path => crossings(path, y)) }
    })
    pixels[row * rowWidth] = 1 // PNG Sub filter.
    let previous = [0, 0, 0, 0]
    for (let col = 0; col < size; col++) {
      const sum = [0, 0, 0]
      let coverage = 0
      for (const { y, edges } of rows) {
        for (let subCol = 0; subCol < samples; subCol++) {
          const x = (col + (subCol + 0.5) / samples) * 100 / size
          const color = paint(x, y, edges)
          if (!color) continue
          for (let channel = 0; channel < 3; channel++) sum[channel] += color[channel]
          coverage++
        }
      }
      const rgba = sum.map(value => coverage ? Math.round(value / coverage) : 0)
      rgba.push(Math.round(255 * coverage / (samples * samples)))
      const offset = row * rowWidth + 1 + col * 4
      for (let channel = 0; channel < 4; channel++) {
        pixels[offset + channel] = (rgba[channel] - previous[channel]) & 0xff
      }
      previous = rgba
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6 // RGBA.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const icons = [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]
for (const [filename, size] of icons) {
  writeFileSync(new URL(filename, iconDir), encodeIcon(size))
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="background" x2=".2" y2="1">
      <stop stop-color="#fff8db"/><stop offset="1" stop-color="#f49b75"/>
    </linearGradient>
    <linearGradient id="gold" x2="0" y2="1">
      <stop stop-color="#fff2b1"/><stop offset="1" stop-color="#e68c42"/>
    </linearGradient>
    <radialGradient id="ruby" cx=".36" cy=".25" r=".76">
      <stop stop-color="#ff8284"/><stop offset=".54" stop-color="#e63766"/><stop offset="1" stop-color="#a11040"/>
    </radialGradient>
    <clipPath id="candy"><path d="${pathString(face)}"/></clipPath>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#background)"/>
  <path fill="#9d3040" d="${pathString(backing)}"/>
  <path fill="url(#gold)" d="${pathString(star)}"/>
  <path fill="url(#ruby)" d="${pathString(face)}"/>
  <path fill="url(#gold)" clip-path="url(#candy)" d="${pathString(ribbon)}"/>
  <path d="M37 37 Q43 32 48 31" fill="none" stroke="#fff4d8" stroke-width="2.5" stroke-linecap="round" opacity=".88"/>
  <path fill="#ffffe5" d="M79 21.6 79.7 24.3 82.4 25 79.7 25.7 79 28.4 78.3 25.7 75.6 25 78.3 24.3Z M20 30.9 20.5 32.5 22.1 33 20.5 33.5 20 35.1 19.5 33.5 17.9 33 19.5 32.5Z"/>
</svg>
`
writeFileSync(new URL('favicon.svg', publicDir), svg)
