import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ChannelInfo, ChatMessage } from '@shared/model'
import { type MessageMap, PAUSED_TRIM_HEADROOM } from '@renderer/chatState'
import { MessageContextMenu } from '@renderer/components/MessageContextMenu'
import { MessageRow } from '@renderer/components/MessageRow'
import { buildOrigins, mergeMonitorMessages } from '@renderer/monitor'

const MIN_COL_WIDTH = 240
const MAX_COL_WIDTH = 820

interface CombinedColumnProps {
  id: string
  label: string
  /** Channel ids whose messages feed this view (stable, for the merge). */
  memberIds: readonly string[]
  /** Resolved member channels (for the origin tags + the chat count). */
  members: ChannelInfo[]
  messagesByChannel: MessageMap
  /** Most recent merged messages to keep (the configured per-chat buffer size). */
  cap: number
  /** Show only moderation-flagged messages (the flagged view) instead of every message (a monitor). */
  flaggedOnly?: boolean
  active: boolean
  palette: readonly string[]
  width: number
  canMoveLeft: boolean
  canMoveRight: boolean
  onActivate: (id: string) => void
  /** Open and focus the message's own column so a mod can act there. */
  onJump: (channelId: string) => void
  /** Open the "User activity" view for a message's author. */
  onUserActivity: (message: ChatMessage) => void
  /** Open the reply thread of the Super Chat a message replies to. */
  onDonationReplies: (message: ChatMessage) => void
  onMove: (id: string, direction: -1 | 1) => void
  /** Remove the view; omitted for the built-in flagged view, which the rule set manages. */
  onRemove?: (id: string) => void
  onResize: (id: string, width: number) => void
  /**
   * Report which channels this view wants buffer-trimming paused for (scrolled up, reading
   * history) — all of its members; an empty list clears the pause. Keyed by this view's id.
   */
  onScrollPause: (id: string, channelIds: readonly string[]) => void
  /** Monitored authors (`<platform>:<authorId>`); the Set's identity changes only on toggle. */
  monitoredKeys?: ReadonlySet<string> | undefined
}

interface ContextMenuState {
  message: ChatMessage
  x: number
  y: number
}

/**
 * A read-only combined column: several chats merged into one time-ordered feed, each row tagged with
 * its origin chat. Used for a monitor (manually-chosen chats) and for the flagged-messages view
 * (`flaggedOnly`: every chat's moderation-flagged messages). Right-click moderates the message in
 * place (routed by its own channelId) or jumps to that chat's column; the origin tag jumps too.
 * Sending happens in the individual columns, so this has no composer.
 */
export function CombinedColumn({
  id,
  label,
  memberIds,
  members,
  messagesByChannel,
  cap,
  flaggedOnly,
  active,
  palette,
  width,
  canMoveLeft,
  canMoveRight,
  onActivate,
  onJump,
  onUserActivity,
  onDonationReplies,
  onMove,
  onRemove,
  onResize,
  onScrollPause,
  monitoredKeys
}: CombinedColumnProps): ReactElement {
  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [menu, setMenu] = useState<ContextMenuState | undefined>(undefined)

  const merged = useMemo(
    // While scrolled up, merge to the paused ceiling instead of `cap`, so the rows being read
    // aren't sliced away (App pauses the member buffers' trim the same way). The ref read is
    // fresh on every recompute — new messages are what trigger one.
    () =>
      mergeMonitorMessages(
        memberIds,
        messagesByChannel,
        atBottomRef.current ? cap : cap + PAUSED_TRIM_HEADROOM,
        flaggedOnly === true
      ),
    [memberIds, messagesByChannel, cap, flaggedOnly]
  )
  // Cheap to rebuild each render; MessageRow compares the origin label/colour by value, so this
  // doesn't force the rows to re-render.
  const origins = buildOrigins(members)

  const openContextMenu = useCallback((message: ChatMessage, x: number, y: number) => {
    setMenu({ message, x, y })
  }, [])

  // Held-for-review messages appear here too (the flagged view); replay their inline actions.
  const runHeldAction = useCallback(
    (channelId: string, token: string) => window.chat.runHeldAction(channelId, token),
    []
  )

  function handleScroll(): void {
    const el = bodyRef.current
    if (!el) {
      return
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom
      // Reading history in a combined view pauses trimming for every member feeding it.
      onScrollPause(id, atBottom ? [] : memberIds)
    }
  }

  // Track membership changes while scrolled up (the flagged view spans every open chat), and
  // never leave members paused after this view unmounts.
  useEffect(() => {
    if (!atBottomRef.current) {
      onScrollPause(id, memberIds)
    }
    return () => {
      onScrollPause(id, [])
    }
  }, [id, memberIds, onScrollPause])

  // Pin to the bottom before paint when the user is already there (matches ChannelColumn).
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [merged])

  // Keep pinned as late-loading images grow rows.
  useEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (body === null || content === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        body.scrollTop = body.scrollHeight
      }
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [])

  // Drag-resize: mutate width during the drag, commit on release (mirrors ChannelColumn).
  function startResize(event: React.MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = sectionRef.current?.offsetWidth ?? width
    const apply = (clientX: number): number => {
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startWidth + (clientX - startX)))
      const el = sectionRef.current
      if (el !== null) {
        el.style.width = `${next}px`
        el.style.flex = `0 0 ${next}px`
      }
      return next
    }
    function onMove(moveEvent: MouseEvent): void {
      apply(moveEvent.clientX)
    }
    function onUp(upEvent: MouseEvent): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      onResize(id, apply(upEvent.clientX))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <section
      ref={sectionRef}
      className={`pc-col mon${flaggedOnly === true ? ' flagged' : ''}${active ? ' active' : ''}`}
      style={{ width: `${width}px`, flex: `0 0 ${width}px` }}
      onMouseDown={() => {
        onActivate(id)
      }}
    >
      <header className="pc-colhead">
        <span className={`tag ${flaggedOnly === true ? 'flag' : 'mon'}`}>
          {flaggedOnly === true ? '⚑' : 'MON'}
        </span>
        <span className="chan">{label}</span>
        <span className="pc-streamnote">{members.length} chats</span>
        <span className="pc-colbtns">
          <button
            type="button"
            className="pc-icbtn"
            disabled={!canMoveLeft}
            title="Move left"
            aria-label="Move left"
            onClick={() => {
              onMove(id, -1)
            }}
          >
            ◂
          </button>
          <button
            type="button"
            className="pc-icbtn"
            disabled={!canMoveRight}
            title="Move right"
            aria-label="Move right"
            onClick={() => {
              onMove(id, 1)
            }}
          >
            ▸
          </button>
          {onRemove !== undefined ? (
            <button
              type="button"
              className="pc-icbtn x"
              title="Remove monitor"
              aria-label="Remove monitor"
              onClick={() => {
                onRemove(id)
              }}
            >
              ✕
            </button>
          ) : null}
        </span>
      </header>

      <div className="pc-stream" ref={bodyRef} onScroll={handleScroll}>
        <div ref={contentRef}>
          {merged.length === 0 ? (
            <div className="pc-empty">
              {flaggedOnly === true ? 'no flagged messages yet' : 'no messages yet'}
            </div>
          ) : (
            merged.map((message) => {
              const origin = origins.get(message.channelId)
              return (
                <MessageRow
                  key={`${message.channelId} ${message.id}`}
                  message={message}
                  palette={palette}
                  onContextMenu={openContextMenu}
                  onHeldAction={runHeldAction}
                  originLabel={origin?.label}
                  originColor={origin?.color}
                  onOriginClick={onJump}
                  monitoredKeys={monitoredKeys}
                />
              )
            })
          )}
        </div>
      </div>

      {menu !== undefined ? (
        <MessageContextMenu
          key={menu.message.id}
          message={menu.message}
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(undefined)
          }}
          onJump={onJump}
          onUserActivity={onUserActivity}
          onDonationReplies={onDonationReplies}
        />
      ) : null}

      <div
        className="pc-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        onMouseDown={startResize}
      />
    </section>
  )
}
