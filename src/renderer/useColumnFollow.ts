import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/model'
import {
  FOLLOWING,
  type Follow,
  JUMPED,
  afterReaderScroll,
  afterScroll
} from '@renderer/scrollFollow'

/** A request to show one message in its column; `seq` makes a repeat jump to it count again. */
export interface JumpTarget {
  channelId: string
  messageId: string
  seq: number
}

/** How long a jumped-to row keeps its highlight. */
const JUMP_FLASH_MS = 2000

interface ColumnFollowOptions {
  /** The scrolling element. */
  bodyRef: RefObject<HTMLDivElement | null>
  /** The element holding the rows, observed for growth. */
  contentRef: RefObject<HTMLDivElement | null>
  /** The column's id, for reporting the trimming pause. */
  columnId: string
  /** See `ChannelColumnProps.onScrollPause`. */
  onScrollPause: (columnId: string, channelIds: readonly string[]) => void
  messages: ChatMessage[]
  /** The latest jump aimed at this column, if any. */
  jumpTo: JumpTarget | undefined
  /** Called when a jump's message is no longer in the column (trimmed from the buffer). Stable. */
  onJumpMissed: () => void
  /** Called with a jump's `seq` once it has been handled, found or not, so it is not repeated. */
  onJumpHandled: (seq: number) => void
}

/** What the column wires into its scroll element. */
export interface ColumnFollow {
  /** Read by other layout code (the composer's resize) to re-pin only while following. */
  followRef: RefObject<Follow>
  /** The scroll element's `onScroll`. */
  handleScroll: () => void
  /** Pointer, touch and key input on the scroll element: the reader is taking over. */
  handleReaderScroll: () => void
  /** The scroll element's `onWheel`. */
  handleWheel: (event: { deltaY: number }) => void
}

/**
 * Keeps a chat column at its newest message while the reader is at the bottom, and still while
 * they read history or after a jump to a message (rules: `scrollFollow.ts`). Buffer trimming is
 * paused whenever the column isn't following, so the rows being read — or jumped to — stay.
 */
export function useColumnFollow(options: ColumnFollowOptions): ColumnFollow {
  const { bodyRef, contentRef, columnId, onScrollPause, messages, jumpTo } = options
  const { onJumpMissed, onJumpHandled } = options
  const followRef = useRef<Follow>(FOLLOWING)

  const setFollow = useCallback(
    (next: Follow): void => {
      const wasPinned = followRef.current.pinned
      followRef.current = next
      if (next.pinned !== wasPinned) {
        // Pause buffer trimming while reading history, so scrollback isn't deleted mid-read.
        onScrollPause(columnId, next.pinned ? [] : [columnId])
      }
    },
    [columnId, onScrollPause]
  )

  const handleScroll = useCallback((): void => {
    const el = bodyRef.current
    if (el !== null) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      setFollow(afterScroll(followRef.current, atBottom))
    }
  }, [bodyRef, setFollow])

  const handleReaderScroll = useCallback((): void => {
    setFollow(afterReaderScroll(followRef.current))
  }, [setFollow])

  const handleWheel = useCallback(
    (event: { deltaY: number }): void => {
      setFollow(afterReaderScroll(followRef.current))
      if (!followRef.current.pinned && event.deltaY > 0) {
        // Scrolling down when already at the bottom moves nothing, so no scroll event would come
        // to resume following; look once the wheel has had its frame. Only a downward wheel: a
        // click or a selection near the bottom must not resume following.
        requestAnimationFrame(handleScroll)
      }
    },
    [setFollow, handleScroll]
  )

  // A removed column must not leave its channel's trimming paused.
  useEffect(() => {
    return () => {
      onScrollPause(columnId, [])
    }
  }, [columnId, onScrollPause])

  // Pin before paint (not after) so a fast chat doesn't show a frame scrolled off the bottom.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el !== null && followRef.current.pinned) {
      el.scrollTop = el.scrollHeight
    }
  }, [bodyRef, messages])

  // Late-loading emote/badge/avatar images grow rows after render; keep the column pinned to the
  // bottom as the content resizes, when the reader is already there.
  useEffect(() => {
    const body = bodyRef.current
    const content = contentRef.current
    if (body === null || content === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      if (followRef.current.pinned) {
        body.scrollTop = body.scrollHeight
      }
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [bodyRef, contentRef])

  // The last jump's re-centring and highlight. They outlive the effect that started them: the jump
  // is consumed (its prop cleared) right away, and that must not cut the highlight short.
  const jumpShownRef = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      jumpShownRef.current?.()
    },
    []
  )

  // Declared after the pin so a column mounted by the jump (tabs layout) pins first, then moves.
  useLayoutEffect(() => {
    if (jumpTo === undefined) {
      return
    }
    onJumpHandled(jumpTo.seq)
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-msgid="${CSS.escape(jumpTo.messageId)}"]`
    )
    if (row === null || row === undefined) {
      onJumpMissed()
      return
    }
    setFollow(JUMPED)
    jumpShownRef.current?.()
    jumpShownRef.current = showJumpedRow(row)
  }, [bodyRef, jumpTo, setFollow, onJumpMissed, onJumpHandled])

  return { followRef, handleScroll, handleReaderScroll, handleWheel }
}

/**
 * Centre a jumped-to row and outline it for a moment; returns what stops both early.
 *
 * Rows off screen render at an estimated height (content-visibility), so the rows brought into
 * view settle to their real size after layout: the row is centred again once they have.
 */
function showJumpedRow(row: HTMLElement): () => void {
  row.scrollIntoView({ block: 'center', inline: 'nearest' })
  const frame = requestAnimationFrame(() => {
    row.scrollIntoView({ block: 'center', inline: 'nearest' })
  })
  row.classList.add('pc-jumped')
  const timer = setTimeout(() => {
    row.classList.remove('pc-jumped')
  }, JUMP_FLASH_MS)
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    row.classList.remove('pc-jumped')
  }
}
