import type { ChannelInfo, MonitorView } from '@shared/model'

/** The built-in flagged-messages view's column id (reserved; not a real channel/monitor). */
export const FLAGGED_COLUMN_ID = 'flagged'

/** A rendered column: a chat channel, a combined monitor view, or the built-in flagged view. */
export type Column =
  | { kind: 'channel'; id: string; channel: ChannelInfo }
  | { kind: 'monitor'; id: string; monitor: MonitorView }
  | { kind: 'flagged'; id: string }

/**
 * Swap a column one step left (`-1`) or right (`+1`). Returns the input array unchanged (same
 * reference) when it can't move (edge, or id absent), so the caller can skip persisting a no-op.
 */
export function moveColumnBy(order: string[], id: string, direction: -1 | 1): string[] {
  const i = order.indexOf(id)
  const j = i + direction
  const a = order[i]
  const b = order[j]
  if (i < 0 || j < 0 || j >= order.length || a === undefined || b === undefined) {
    return order
  }
  const next = [...order]
  next[i] = b
  next[j] = a
  return next
}

/**
 * Move a column to `toIndex` (its position in the list once removed), for drag-to-reorder. Clamped
 * to the valid range. Returns the input array unchanged (same reference) when the id is absent or the
 * position doesn't change, so the caller can skip persisting a no-op.
 */
export function moveColumnTo(order: string[], id: string, toIndex: number): string[] {
  if (!order.includes(id)) {
    return order
  }
  const without = order.filter((existing) => existing !== id)
  const clamped = Math.max(0, Math.min(without.length, toIndex))
  const next = [...without.slice(0, clamped), id, ...without.slice(clamped)]
  return next.length === order.length && next.every((existing, k) => existing === order[k])
    ? order
    : next
}

/**
 * Default left-to-right priority for a column that hasn't been explicitly placed: the flagged
 * (moderation) view leads, monitor views come second, chat columns follow.
 */
function rankOf(id: string, monitorIds: ReadonlySet<string>): number {
  return id === FLAGGED_COLUMN_ID ? 0 : monitorIds.has(id) ? 1 : 2
}

/**
 * Insert before the first column of a lower priority class, so an unplaced flagged view sits
 * leftmost and an unplaced monitor sits right after the flagged/monitor block.
 */
export function rankInsert(list: string[], id: string, monitorIds: ReadonlySet<string>): string[] {
  const at = list.findIndex((existing) => rankOf(existing, monitorIds) > rankOf(id, monitorIds))
  return at === -1 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)]
}

export interface ReconcileOptions {
  /** Whether the flagged view currently exists (any moderation watchlist term configured). */
  flaggedVisible: boolean
  /** Ids of the configured monitor views. */
  monitorIds: ReadonlySet<string>
  /** Open chat channel ids, in the order main reports them. */
  channelIds: readonly string[]
  /**
   * The persisted arrangement (settings.columnOrder), passed exactly once after settings hydrate:
   * ids it names keep their stored relative order; everything else re-slots by the default rule.
   * Undefined on every other reconcile, where the session's current order wins.
   */
  stored?: readonly string[] | undefined
}

/**
 * Reconcile the session's column order against the authoritative membership. Columns the user has
 * placed (this session, or via `stored`) stay put; new/unplaced columns slot in by the default
 * rule — flagged leftmost, monitors second, chats after. Returns `prev` itself when nothing
 * changed, so callers can skip a re-render.
 */
export function reconcileColumnOrder(prev: string[], options: ReconcileOptions): string[] {
  const { flaggedVisible, monitorIds, channelIds, stored } = options
  const ids = [...(flaggedVisible ? [FLAGGED_COLUMN_ID] : []), ...monitorIds, ...channelIds]
  let base = prev.filter((id) => ids.includes(id))
  if (stored !== undefined) {
    const storedIndex = new Map(stored.map((id, index) => [id, index]))
    const placed = base
      .filter((id) => storedIndex.has(id))
      .sort((a, b) => (storedIndex.get(a) ?? 0) - (storedIndex.get(b) ?? 0))
    const unplaced = base.filter((id) => !storedIndex.has(id))
    base = placed
    for (const id of unplaced) {
      base = rankInsert(base, id, monitorIds)
    }
  }
  for (const id of ids) {
    if (!base.includes(id)) {
      base = rankInsert(base, id, monitorIds)
    }
  }
  const unchanged = base.length === prev.length && base.every((id, i) => id === prev[i])
  return unchanged ? prev : base
}
