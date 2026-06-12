import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { ChatAction, ChatMessage } from '@shared/model'
import { wrapIndex } from '@renderer/listNav'
import { clampMenuPosition } from '@renderer/overlayPosition'

/** A duration in seconds as a human label (e.g. 10 → "10 seconds", 86400 → "24 hours"). */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const hours = Math.round(seconds / 3600)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

interface MessageContextMenuProps {
  message: ChatMessage
  x: number
  y: number
  onClose: () => void
  /** Reply affordance — omitted in read-only/monitor contexts. */
  onReply?: ((message: ChatMessage) => void) | undefined
  /** Jump to the message's own column — used by the combined monitor view. */
  onJump?: ((channelId: string) => void) | undefined
  /** Open this author's "User activity" view; omitted inside that view to avoid nesting. */
  onUserActivity?: ((message: ChatMessage) => void) | undefined
  /** Open a Super Chat's reply thread; only shown on a message that replies to a donation. */
  onDonationReplies?: ((message: ChatMessage) => void) | undefined
}

/**
 * The right-click menu for a chat message: an optional Reply, an optional "Go to chat" jump, and the
 * platform's moderation actions (block, plus remove/timeout/ban for mods). Actions are
 * fetched and run against the message's own `channelId`, so the same menu works in a single column
 * and in the combined monitor view, where each row may originate from a different chat.
 * Fully keyboard-driven: focus moves in on open (and back on close), arrows walk the items with
 * wrap-around, and Escape closes the menu without touching any modal underneath it.
 */
export function MessageContextMenu({
  message,
  x,
  y,
  onClose,
  onReply,
  onJump,
  onUserActivity,
  onDonationReplies
}: MessageContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [actions, setActions] = useState<ChatAction[]>([])
  const [loading, setLoading] = useState(false)
  // A destructive action awaiting a second (confirming) click, and any action error to show in-menu.
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  // A timeout action awaiting a duration choice (shows the duration picker instead of a confirm).
  const [timeoutFor, setTimeoutFor] = useState<ChatAction | undefined>(undefined)
  // Cursor position until the menu is measured, then clamped fully inside the viewport.
  const [position, setPosition] = useState({ top: y, left: x })

  const token = message.menuToken

  // Keep the menu on screen: measure and clamp before paint, re-clamping whenever the contents
  // change size (action list arrives, the timeout submenu opens, an error row appears).
  useLayoutEffect(() => {
    const el = menuRef.current
    if (el === null) {
      return
    }
    const rect = el.getBoundingClientRect()
    const next = clampMenuPosition({
      x,
      y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    })
    setPosition((prev) => (prev.top === next.top && prev.left === next.left ? prev : next))
  }, [x, y, timeoutFor, actions, loading, confirming, error])

  // Move focus into the menu on open (first item, or the menu itself while actions load) and hand
  // it back to wherever it was on close.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const root = menuRef.current
    const firstButton = root?.querySelector<HTMLButtonElement>('button')
    ;(firstButton ?? root)?.focus()
    return () => {
      if (opener !== undefined && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [])

  // Fetch the message's actions on open; the set already reflects the account's role in that chat.
  useEffect(() => {
    if (token === undefined) {
      setLoading(false)
      return undefined
    }
    let active = true
    setLoading(true)
    void window.chat
      .getMessageActions(message.channelId, token)
      .then((result) => {
        if (active) {
          setActions(result)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setActions([])
          setLoading(false)
          setError("couldn't load actions")
        }
      })
    return () => {
      active = false
    }
  }, [message.channelId, token])

  // Execute an action (optionally with a timeout duration), closing the menu on success.
  async function execute(actionId: string, timeoutSeconds?: number): Promise<void> {
    if (token === undefined) {
      return
    }
    setError(undefined)
    try {
      const result = await window.chat.runMessageAction(
        message.channelId,
        token,
        actionId,
        timeoutSeconds
      )
      if (result.ok) {
        onClose()
      } else {
        setError(result.error)
        setConfirming(undefined)
      }
    } catch {
      setError('action failed')
      setConfirming(undefined)
    }
  }

  // A timeout opens the duration picker; other destructive actions need a confirming second click.
  function onActionClick(action: ChatAction): void {
    if (action.timeoutDurations !== undefined && action.timeoutDurations.length > 0) {
      setTimeoutFor(action)
      return
    }
    if (action.destructive && confirming !== action.id) {
      setConfirming(action.id)
      return
    }
    void execute(action.id)
  }

  // Escape closes just the menu (never a modal underneath); arrows walk the items with wrap-around.
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
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')]
    if (buttons.length === 0) {
      return
    }
    const current = buttons.findIndex((button) => button === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const fallback = delta === 1 ? 0 : buttons.length - 1
    const next = buttons[current === -1 ? fallback : wrapIndex(current, delta, buttons.length)]
    next?.focus()
    next?.scrollIntoView({ block: 'nearest' })
  }

  // No Reply on synthetic rows: system notices and self echoes carry locally generated ids the
  // platform never saw, so a reply targeting them is rejected.
  const hasReply = onReply !== undefined && message.system !== true && message.self !== true
  const hasJump = onJump !== undefined
  // "User activity" compiles this author's seen messages locally, so it's offered on any real chat
  // line regardless of login/role (not on system event lines, which have no meaningful author).
  const hasUserActivity = onUserActivity !== undefined && message.system !== true
  // "Donation replies" is only meaningful on a message that replies to a Super Chat (carries a token).
  const hasDonationReplies =
    onDonationReplies !== undefined && message.reply?.threadToken !== undefined

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
        {timeoutFor !== undefined ? (
          <>
            <div className="pc-ctx-head">timeout duration</div>
            {(timeoutFor.timeoutDurations ?? []).map((seconds) => (
              <button
                key={seconds}
                type="button"
                onClick={() => {
                  void execute(timeoutFor.id, seconds)
                }}
              >
                {formatDuration(seconds)}
              </button>
            ))}
            <div className="pc-ctx-sep" />
            <button
              type="button"
              onClick={() => {
                setTimeoutFor(undefined)
              }}
            >
              cancel
            </button>
            {error !== undefined ? <div className="pc-ctx-err">{error}</div> : null}
          </>
        ) : (
          <>
            {hasReply ? (
              <button
                type="button"
                onClick={() => {
                  onReply?.(message)
                }}
              >
                reply
              </button>
            ) : null}
            {hasJump ? (
              <button
                type="button"
                onClick={() => {
                  onJump?.(message.channelId)
                  onClose()
                }}
              >
                go to chat
              </button>
            ) : null}
            {hasUserActivity ? (
              <button
                type="button"
                onClick={() => {
                  onUserActivity?.(message)
                  onClose()
                }}
              >
                user activity
              </button>
            ) : null}
            {hasDonationReplies ? (
              <button
                type="button"
                onClick={() => {
                  onDonationReplies?.(message)
                  onClose()
                }}
              >
                donation replies
              </button>
            ) : null}
            {(hasReply || hasJump || hasUserActivity || hasDonationReplies) &&
            (actions.length > 0 || loading) ? (
              <div className="pc-ctx-sep" />
            ) : null}
            {loading && actions.length === 0 ? <div className="pc-ctx-load">…</div> : null}
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={action.destructive ? 'danger' : undefined}
                onClick={() => {
                  onActionClick(action)
                }}
              >
                {confirming === action.id ? `confirm — ${action.label}?` : action.label}
              </button>
            ))}
            {error !== undefined ? <div className="pc-ctx-err">{error}</div> : null}
          </>
        )}
      </div>
    </>
  )
}
