/** Inputs for placing a fixed-position context menu opened at a cursor point. */
export interface MenuPlacement {
  /** Cursor position the menu opened at. */
  x: number
  y: number
  /** Measured menu size. */
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

/** Minimum gap kept between the menu and the viewport edge. */
export const MENU_VIEWPORT_MARGIN = 8

/**
 * Place a context menu at the cursor, flipping to the cursor's other side when it would overflow
 * the viewport, then clamping into the margins — so the menu is always fully on screen.
 */
export function clampMenuPosition(placement: MenuPlacement): { top: number; left: number } {
  return {
    left: clampAxis(placement.x, placement.width, placement.viewportWidth),
    top: clampAxis(placement.y, placement.height, placement.viewportHeight)
  }
}

function clampAxis(start: number, size: number, viewport: number): number {
  let position = start
  if (position + size > viewport - MENU_VIEWPORT_MARGIN) {
    // Flip to the other side of the cursor; the clamp below catches a menu too big either way.
    position = start - size
  }
  return Math.max(MENU_VIEWPORT_MARGIN, Math.min(position, viewport - MENU_VIEWPORT_MARGIN - size))
}
