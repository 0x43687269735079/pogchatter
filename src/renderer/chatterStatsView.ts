import type { ChatterSummary } from '@shared/chatterStats'

export type ChatterSort = 'streams' | 'messages' | 'lastSeen'

/** Rows shown at once; a filter narrows the rest. Keeps a creator with years of chat responsive. */
export const CHATTER_ROW_LIMIT = 300

/**
 * The chatters to show: matching `filter` (by name, case-insensitive, or exact channel id), in
 * `sort` order with ties broken by the other measures, capped at `limit`.
 */
export function viewChatters(
  chatters: readonly ChatterSummary[],
  sort: ChatterSort,
  filter: string,
  limit: number = CHATTER_ROW_LIMIT
): ChatterSummary[] {
  const query = filter.trim().toLowerCase()
  const matching =
    query === ''
      ? [...chatters]
      : chatters.filter(
          (chatter) =>
            chatter.name.toLowerCase().includes(query) || chatter.id.toLowerCase() === query
        )
  const order: Record<ChatterSort, (a: ChatterSummary, b: ChatterSummary) => number> = {
    streams: (a, b) => b.streams - a.streams || b.messages - a.messages || b.lastSeen - a.lastSeen,
    messages: (a, b) => b.messages - a.messages || b.streams - a.streams || b.lastSeen - a.lastSeen,
    lastSeen: (a, b) => b.lastSeen - a.lastSeen || b.streams - a.streams || b.messages - a.messages
  }
  return matching.sort(order[sort]).slice(0, limit)
}
