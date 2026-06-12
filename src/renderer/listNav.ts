/** Next index moving by `delta` with wrap-around (menu rows, autocomplete lists). */
export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) {
    return 0
  }
  return (((current + delta) % length) + length) % length
}

export type GridDirection = 'left' | 'right' | 'up' | 'down'

/**
 * Move within a row-major grid of `total` cells laid out `columns` per row, clamping at the
 * edges: left/right step one cell, up/down step a whole row (staying put when no row exists).
 */
export function moveGridIndex(
  index: number,
  direction: GridDirection,
  columns: number,
  total: number
): number {
  if (total <= 0) {
    return 0
  }
  if (direction === 'left') {
    return Math.max(0, index - 1)
  }
  if (direction === 'right') {
    return Math.min(total - 1, index + 1)
  }
  const step = Math.max(1, columns)
  if (direction === 'up') {
    return index - step >= 0 ? index - step : index
  }
  return index + step < total ? index + step : index
}
