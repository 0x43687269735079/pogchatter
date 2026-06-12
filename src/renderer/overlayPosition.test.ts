import { describe, expect, it } from 'vitest'
import { clampMenuPosition, MENU_VIEWPORT_MARGIN } from '@renderer/overlayPosition'

const VIEWPORT = { viewportWidth: 800, viewportHeight: 600 }

describe('clampMenuPosition', () => {
  it('keeps a menu that fits at the cursor', () => {
    const pos = clampMenuPosition({ x: 100, y: 200, width: 150, height: 180, ...VIEWPORT })
    expect(pos).toEqual({ left: 100, top: 200 })
  })

  it('flips left of the cursor when it would overflow the right edge', () => {
    const pos = clampMenuPosition({ x: 780, y: 100, width: 150, height: 100, ...VIEWPORT })
    expect(pos.left).toBe(780 - 150)
    expect(pos.top).toBe(100)
  })

  it('flips above the cursor when it would overflow the bottom edge', () => {
    const pos = clampMenuPosition({ x: 100, y: 590, width: 120, height: 200, ...VIEWPORT })
    expect(pos.top).toBe(590 - 200)
    expect(pos.left).toBe(100)
  })

  it('clamps to the margin when flipping would push past the top/left edge', () => {
    const pos = clampMenuPosition({ x: 4, y: 5, width: 798, height: 598, ...VIEWPORT })
    expect(pos.left).toBe(MENU_VIEWPORT_MARGIN)
    expect(pos.top).toBe(MENU_VIEWPORT_MARGIN)
  })

  it('never places the right/bottom edge past the viewport minus margin when it fits', () => {
    const pos = clampMenuPosition({ x: 795, y: 595, width: 150, height: 180, ...VIEWPORT })
    expect(pos.left + 150).toBeLessThanOrEqual(800 - MENU_VIEWPORT_MARGIN)
    expect(pos.top + 180).toBeLessThanOrEqual(600 - MENU_VIEWPORT_MARGIN)
  })

  it('pins an oversized menu to the top-left margin', () => {
    const pos = clampMenuPosition({ x: 400, y: 300, width: 1000, height: 900, ...VIEWPORT })
    expect(pos).toEqual({ left: MENU_VIEWPORT_MARGIN, top: MENU_VIEWPORT_MARGIN })
  })

  it('clamps a cursor outside the viewport back inside', () => {
    const pos = clampMenuPosition({ x: -50, y: -20, width: 100, height: 80, ...VIEWPORT })
    expect(pos.left).toBeGreaterThanOrEqual(MENU_VIEWPORT_MARGIN)
    expect(pos.top).toBeGreaterThanOrEqual(MENU_VIEWPORT_MARGIN)
  })
})
