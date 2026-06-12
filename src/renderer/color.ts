/** Minimal colour helpers for rendering super-chat cards from the platform-provided colour. */

function parseHex(hex: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (match?.[1] === undefined) {
    return undefined
  }
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** Darken a hex colour toward black by `amount` (0–1) — used for the super-chat header band. */
export function darken(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  if (rgb === undefined) {
    return hex
  }
  return toHex([rgb[0] * (1 - amount), rgb[1] * (1 - amount), rgb[2] * (1 - amount)])
}

/** Readable text colour (near-black or white) for a given background. */
export function contrastText(hex: string): string {
  const rgb = parseHex(hex)
  if (rgb === undefined) {
    return '#ffffff'
  }
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return luminance > 0.55 ? '#161a20' : '#ffffff'
}
