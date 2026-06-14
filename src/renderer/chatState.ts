import { DEFAULT_BUFFER_SIZE } from '@shared/model'
import type { ChannelInfo, ChatEvent, ChatMessage } from '@shared/model'

/** Per-channel buffer of messages, oldest first. */
export type MessageMap = Record<string, ChatMessage[]>

/**
 * Extra rows a paused channel (one a scrolled-up column is reading) may hold past `cap` before
 * trimming kicks in anyway, so scrollback isn't deleted out from under the reader but a left-open
 * column can't grow without bound.
 */
export const PAUSED_TRIM_HEADROOM = 1000

/** Flagged rows retained past the trim limit per channel, held for the Flagged review view. */
export const FLAGGED_RETENTION = 200

/**
 * Fold a batch of chat events into the per-channel message buffers, capping each channel at `cap`
 * messages (the configurable buffer size) so a long-running fast chat doesn't grow without bound.
 * Channels in `paused` (being read while scrolled up) trim only at a hard ceiling of
 * `cap + PAUSED_TRIM_HEADROOM`; flagged rows survive trimming (up to {@link FLAGGED_RETENTION}
 * beyond the limit) so watchlist hits stay reviewable until a moderator sees them.
 *
 * Messages are deduplicated by id: YouTube re-sends recent chat items across polls (invalidation
 * mode), and a reader reconnect replays recent history — so the same item id can arrive more than
 * once. Appending it again would render a duplicate row and hand React two children with the same
 * `key` (which then mis-reconciles on the next update). Returns `prev` unchanged when nothing
 * applied, so the caller can skip a re-render.
 */
export function applyEventsToMessages(
  prev: MessageMap,
  events: ChatEvent[],
  cap: number = DEFAULT_BUFFER_SIZE,
  paused?: ReadonlySet<string>
): MessageMap {
  let changed = false
  const next: MessageMap = { ...prev }
  const touched = new Set<string>()
  // Lazily-built per-channel id sets so the dedup check is O(1) per message within the batch.
  const idCache = new Map<string, Set<string>>()
  const idsFor = (channelId: string): Set<string> => {
    let ids = idCache.get(channelId)
    if (ids === undefined) {
      ids = new Set((next[channelId] ?? []).map((message) => message.id))
      idCache.set(channelId, ids)
    }
    return ids
  }

  for (const event of events) {
    if (event.kind === 'message') {
      const ids = idsFor(event.channelId)
      if (ids.has(event.message.id)) {
        continue // already shown — a re-send or replayed history line
      }
      ids.add(event.message.id)
      next[event.channelId] = [...(next[event.channelId] ?? []), event.message]
      touched.add(event.channelId)
      changed = true
    } else if (event.kind === 'replace') {
      // Update a buffered row in place (held → approved/hidden) without moving it. Ignore a
      // replacement whose target is no longer buffered (already trimmed).
      const list = next[event.channelId]
      if (list === undefined || !list.some((m) => m.id === event.message.id)) {
        continue
      }
      next[event.channelId] = list.map((m) => (m.id === event.message.id ? event.message : m))
      changed = true
    } else if (event.kind === 'clear') {
      const list = next[event.channelId]
      if (!list) {
        continue
      }
      const { messageId, userId } = event.target
      if (messageId !== undefined) {
        next[event.channelId] = list.map((m) => (m.id === messageId ? { ...m, deleted: true } : m))
      } else if (userId !== undefined) {
        next[event.channelId] = list.map((m) =>
          m.author.id === userId ? { ...m, deleted: true } : m
        )
      } else {
        next[event.channelId] = []
        idCache.delete(event.channelId) // whole-chat clear: forget the seen ids too
      }
      changed = true
    } else if (event.kind === 'authorUpdate') {
      // An author's avatar resolved after their messages rendered (Twitch's lazy batched lookup):
      // back-fill the buffered rows so the author's earliest messages match the later ones.
      const list = next[event.channelId]
      if (!list) {
        continue
      }
      let backfilled = false
      const updated = list.map((m) => {
        if (m.author.name !== event.login || m.author.avatarUrl !== undefined) {
          return m
        }
        backfilled = true
        return { ...m, author: { ...m.author, avatarUrl: event.avatarUrl } }
      })
      if (backfilled) {
        next[event.channelId] = updated
        changed = true
      }
    } else if (event.kind === 'channels') {
      // Drop buffers for removed channels so they don't leak or reappear if re-added.
      const present = new Set(event.channels.map((channel) => channel.id))
      for (const channelId of Object.keys(next)) {
        if (!present.has(channelId)) {
          delete next[channelId]
          changed = true
        }
      }
    }
  }

  if (!changed) {
    return prev
  }
  for (const channelId of touched) {
    const list = next[channelId]
    const limit = paused?.has(channelId) === true ? cap + PAUSED_TRIM_HEADROOM : cap
    if (list && list.length > limit) {
      next[channelId] = trimRetainingFlagged(list, limit)
    }
  }
  return next
}

/**
 * Trim a buffer to its newest `limit` rows, but carry rows awaiting a moderator's review across the
 * cut — newest {@link FLAGGED_RETENTION} of them — so the Flagged view doesn't lose evidence to
 * ordinary buffer turnover. That's watchlist hits (`flagged`) and YouTube automod "held for review"
 * messages (`held`), the two categories the Flagged view surfaces. Retained rows keep their
 * chronological position ahead of the kept tail.
 */
function trimRetainingFlagged(list: ChatMessage[], limit: number): ChatMessage[] {
  const cut = list.length - limit
  const flagged: ChatMessage[] = []
  for (let i = 0; i < cut; i += 1) {
    const message = list[i]
    if (message !== undefined && (message.flagged === true || message.held !== undefined)) {
      flagged.push(message)
    }
  }
  const retained = flagged.length > FLAGGED_RETENTION ? flagged.slice(-FLAGGED_RETENTION) : flagged
  return retained.length === 0 ? list.slice(cut) : [...retained, ...list.slice(cut)]
}

/** Fold a batch into the channel list (membership, per-source status, send restriction). */
export function applyEventsToChannels(prev: ChannelInfo[], events: ChatEvent[]): ChannelInfo[] {
  let next = prev
  for (const event of events) {
    if (event.kind === 'channels') {
      next = event.channels
    } else if (event.kind === 'status') {
      const { channelId, status } = event
      next = next.map((channel) => (channel.id === channelId ? { ...channel, status } : channel))
    } else if (event.kind === 'sendRestriction') {
      const { channelId, reason } = event
      next = next.map((channel) => {
        if (channel.id !== channelId) {
          return channel
        }
        const { sendRestriction: _drop, ...rest } = channel
        return reason === undefined ? rest : { ...rest, sendRestriction: reason }
      })
    }
  }
  return next
}
