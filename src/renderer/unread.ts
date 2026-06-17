import type { ChatEvent } from '@shared/model'

/**
 * A tab's unread state in the tabs layout: nothing new, ordinary new messages (`activity`), or a
 * ping/highlight, moderation-flag, or held-for-review item that wants a moderator's eye (`alert`).
 */
export type UnreadLevel = 'none' | 'activity' | 'alert'

const RANK: Record<UnreadLevel, number> = { none: 0, activity: 1, alert: 2 }

/** Raise `id` to `level` if that's higher than its current level. Returns whether it changed. */
function escalate(map: Map<string, UnreadLevel>, id: string, level: UnreadLevel): boolean {
  const current = map.get(id) ?? 'none'
  if (RANK[level] <= RANK[current]) {
    return false
  }
  map.set(id, level)
  return true
}

export interface FoldUnreadInput {
  prev: ReadonlyMap<string, UnreadLevel>
  /** The batch already filtered for re-sends and tagged by processEvents (`ping`/`flagged`). */
  events: ChatEvent[]
  activeId: string | undefined
  flaggedColumnId: string
  /** Whether the flagged-for-review view is currently a column/tab. */
  flaggedVisible: boolean
}

/**
 * Fold a batch of chat events into per-column unread levels for the tab bar. A new message in a
 * non-active column raises it to `activity`; a ping/flag/held message raises it to `alert` (alert
 * never downgrades). Any flagged/held message also raises the flagged-view tab to `alert` while it's
 * visible and not active — so a moderator sees a held/flagged item land even in a hidden tab. The
 * active column never accumulates (it's on screen). Returns `prev` unchanged (same reference) when
 * nothing changed, so the caller can skip a re-render.
 */
export function foldUnread(input: FoldUnreadInput): ReadonlyMap<string, UnreadLevel> {
  const { prev, events, activeId, flaggedColumnId, flaggedVisible } = input
  const next = new Map(prev)
  let changed = false
  for (const event of events) {
    if (event.kind !== 'message') {
      continue
    }
    const message = event.message
    // A ping/highlight alerts the chat's own tab; only a moderation flag or held item also alerts the
    // flagged-for-review tab (that view aggregates flagged/held, not highlights).
    const flagged = message.flagged === true || message.held !== undefined
    const columnAlert = flagged || message.ping !== undefined
    if (event.channelId !== activeId) {
      changed = escalate(next, event.channelId, columnAlert ? 'alert' : 'activity') || changed
    }
    if (flagged && flaggedVisible && flaggedColumnId !== activeId) {
      changed = escalate(next, flaggedColumnId, 'alert') || changed
    }
  }
  return changed ? next : prev
}

/** Clear a column's unread level (its tab is now active/visible). Returns `prev` unchanged if clear. */
export function clearUnread(
  prev: ReadonlyMap<string, UnreadLevel>,
  id: string
): ReadonlyMap<string, UnreadLevel> {
  if ((prev.get(id) ?? 'none') === 'none') {
    return prev
  }
  const next = new Map(prev)
  next.delete(id)
  return next
}
