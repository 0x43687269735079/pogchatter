import { describe, expect, it } from 'vitest'
import { moveGridIndex, wrapIndex } from '@renderer/listNav'

describe('wrapIndex', () => {
  it('moves forward and backward within bounds', () => {
    expect(wrapIndex(1, 1, 5)).toBe(2)
    expect(wrapIndex(3, -1, 5)).toBe(2)
  })

  it('wraps past the last item to the first', () => {
    expect(wrapIndex(4, 1, 5)).toBe(0)
  })

  it('wraps before the first item to the last', () => {
    expect(wrapIndex(0, -1, 5)).toBe(4)
  })

  it('returns 0 for an empty list', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0)
    expect(wrapIndex(3, -1, -2)).toBe(0)
  })
})

describe('moveGridIndex', () => {
  // A 3-column grid of 8 cells:
  //   0 1 2
  //   3 4 5
  //   6 7
  it('steps one cell left/right and clamps at the row ends', () => {
    expect(moveGridIndex(4, 'right', 3, 8)).toBe(5)
    expect(moveGridIndex(4, 'left', 3, 8)).toBe(3)
    expect(moveGridIndex(0, 'left', 3, 8)).toBe(0)
    expect(moveGridIndex(7, 'right', 3, 8)).toBe(7)
  })

  it('steps a whole row up/down', () => {
    expect(moveGridIndex(4, 'down', 3, 8)).toBe(7)
    expect(moveGridIndex(4, 'up', 3, 8)).toBe(1)
  })

  it('stays put when no row exists above/below', () => {
    expect(moveGridIndex(1, 'up', 3, 8)).toBe(1)
    expect(moveGridIndex(6, 'down', 3, 8)).toBe(6)
    // 5 + 3 = 8 is out of range — the bottom row is shorter.
    expect(moveGridIndex(5, 'down', 3, 8)).toBe(5)
  })

  it('treats a degenerate column count as one column', () => {
    expect(moveGridIndex(2, 'down', 0, 5)).toBe(3)
    expect(moveGridIndex(2, 'up', -4, 5)).toBe(1)
  })

  it('returns 0 for an empty grid', () => {
    expect(moveGridIndex(0, 'down', 3, 0)).toBe(0)
  })
})
