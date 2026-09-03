import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { wrapIndex } from '@renderer/listNav'
import { clampMenuPosition } from '@renderer/overlayPosition'

export interface TabContextMenuItem {
  label: string
  disabled?: boolean | undefined
  /** Shown as the item's title (tooltip) — e.g. why it's disabled. */
  hint?: string | undefined
  onSelect: () => void
}

interface TabContextMenuProps {
  anchor: { x: number; y: number }
  items: TabContextMenuItem[]
  onClose: () => void
}

/**
 * The right-click menu for a chat tab or column header: a small fixed panel of action buttons,
 * clamped fully on screen and closed by a backdrop click, a second right-click, or Escape.
 *
 * Shares its shell with `MessageContextMenu` (backdrop, clamped positioning, focus trap, arrow-key
 * navigation) but its item list is given directly rather than fetched, since there's only ever one
 * item today.
 */
export function TabContextMenu({ anchor, items, onClose }: TabContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x })

  // Keep the menu on screen: measure and clamp before paint, re-clamping if the item list changes.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (el === null) {
      return
    }
    const rect = el.getBoundingClientRect()
    const next = clampMenuPosition({
      x: anchor.x,
      y: anchor.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    })
    setPosition((prev) => (prev.top === next.top && prev.left === next.left ? prev : next))
  }, [anchor.x, anchor.y, items])

  // Move focus into the menu on open, and hand it back to wherever it was on close.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const root = menuRef.current
    const firstButton = root?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ;(firstButton ?? root)?.focus()
    return () => {
      if (opener !== undefined && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [])

  // Escape closes the menu; arrows walk the enabled items with wrap-around.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }
    event.preventDefault()
    const root = menuRef.current
    if (root === null) {
      return
    }
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (buttons.length === 0) {
      return
    }
    const current = buttons.findIndex((button) => button === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const fallback = delta === 1 ? 0 : buttons.length - 1
    const next = buttons[current === -1 ? fallback : wrapIndex(current, delta, buttons.length)]
    next?.focus()
  }

  return (
    <>
      <div
        className="pc-ctx-backdrop"
        onMouseDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="pc-ctx"
        tabIndex={-1}
        style={{ top: position.top, left: position.left }}
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}
