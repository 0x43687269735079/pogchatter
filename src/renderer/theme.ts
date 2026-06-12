export type ThemeKey = 'ice' | 'midnight'

/** Default theme (the design's primary palette). A switcher is deferred to a future settings panel. */
export const DEFAULT_THEME: ThemeKey = 'ice'

/** Per-theme deterministic username colour palette (from the design tokens). */
export const THEME_PALETTES: Record<ThemeKey, readonly string[]> = {
  ice: [
    '#88c0d0',
    '#8fbcbb',
    '#a3be8c',
    '#b48ead',
    '#ebcb8b',
    '#81a1c1',
    '#e89aa0',
    '#a0c4d8',
    '#bf94c4',
    '#9fc08a'
  ],
  midnight: [
    '#56c2d6',
    '#7ee0a8',
    '#b69cff',
    '#ff9e64',
    '#f2c66b',
    '#9ad06b',
    '#ff8a8a',
    '#79c0ff',
    '#e0a3ff',
    '#5ad1b0'
  ]
}

function hashStr(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic username colour, hashed into the active theme palette (the fallback when the platform gives no colour). */
export function nameColor(name: string, palette: readonly string[]): string {
  return palette[hashStr(name) % palette.length] ?? palette[0] ?? '#d8dee9'
}

/** Deterministic mirrored 5×5 identicon cells, used as the avatar fallback. */
export function identiconCells(seed: string): Array<[number, number]> {
  const hash = hashStr(`${seed}#ava`)
  const cells: Array<[number, number]> = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((hash >> (y * 3 + x)) & 1) {
        cells.push([x, y])
        if (x < 2) {
          cells.push([4 - x, y])
        }
      }
    }
  }
  return cells
}
