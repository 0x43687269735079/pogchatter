import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef
} from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalShellProps {
  /** Extra panel class (e.g. pc-modal-wide). */
  className?: string | undefined
  /** Called on Escape and on a click on the dimmed backdrop, besides the modal's own buttons. */
  onClose: () => void
  /**
   * Whether Escape and a backdrop click dismiss (default true). Modals holding state a stray
   * keypress or mis-click must not destroy — a pending device code, pasted credentials, a
   * half-built form — set false so only their explicit buttons close them.
   */
  dismissable?: boolean
  children: ReactNode
}

/**
 * Shared modal chrome: the dimmed overlay plus the panel each modal fills with its mh/mb/mf rows.
 * Owns the interaction contract — focus moves into the panel on open (unless a child autofocused
 * itself first) and returns to the opener on close, Escape and a backdrop click dismiss (unless
 * `dismissable` is off), and Tab cycles inside the overlay instead of walking into the chrome
 * behind it.
 */
export function ModalShell({
  className,
  onClose,
  dismissable = true,
  children
}: ModalShellProps): ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const overlay = overlayRef.current
    // A child that autofocused itself (search input, composer field) keeps focus; otherwise the
    // panel takes it so Escape and Tab work immediately.
    if (overlay !== null && !overlay.contains(document.activeElement)) {
      panelRef.current?.focus()
    }
    return () => {
      if (opener !== undefined && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // Swallowed even when not dismissable: Escape must never reach the handlers behind a modal.
      event.preventDefault()
      event.stopPropagation()
      if (dismissable) {
        onClose()
      }
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const overlay = overlayRef.current
    if (overlay === null) {
      return
    }
    const focusables = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = focusables[0]
    const last = focusables.at(-1)
    if (first === undefined || last === undefined) {
      event.preventDefault()
      return
    }
    const current = document.activeElement
    if (event.shiftKey) {
      if (current === first || current === panelRef.current) {
        event.preventDefault()
        last.focus()
      }
    } else if (current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={overlayRef}
      className="pc-modal-overlay"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={className === undefined ? 'pc-modal' : `pc-modal ${className}`}
      >
        {children}
      </div>
    </div>
  )
}
