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
      // A held-for-review message carries its original send time. The standing moderation backlog a
      // moderator receives on connect predates the live messages, so slot it into chat order by
      // timestamp instead of appending it to the bottom. Live messages append (they arrive in order,
      // so insertByTimestamp would land them at the end anyway — appending keeps that path O(1)).
      const list = next[event.channelId] ?? []
      next[event.channelId] =
        event.message.held !== undefined
          ? insertByTimestamp(list, event.message)
          : [...list, event.message]
      touched.add(event.channelId)
      changed = true
    } else if (event.kind === 'replace') {
      const ids = idsFor(event.channelId)
      if (ids.has(event.message.id)) {
        // Update the buffered row in place (held → approved/hidden) without moving it.
        next[event.channelId] = (next[event.channelId] ?? []).map((m) =>
          m.id === event.message.id ? event.message : m
        )
        changed = true
      } else if (event.message.held !== undefined || event.message.deleted === true) {
        // A moderated item — still-pending held, or already hidden — can arrive as a replace of a
        // message we never buffered: a moderator joining a stream gets the standing moderation
        // backlog as the end-state of items whose original add predates this connection. Surface it
        // rather than dropping it, so the moderator sees it (a held card, or a struck "removed"
        // line). Insert at its send-time slot, not the end, so it sits in chat order rather than
        // jumping to the bottom. A plain unbuffered replacement is an approved/edited message we
        // missed or one that was trimmed — nothing to moderate, so ignore it.
        ids.add(event.message.id)
        next[event.channelId] = insertByTimestamp(next[event.channelId] ?? [], event.message)
        touched.add(event.channelId)
        changed = true
      }
    } else if (event.kind === 'clear') {
      const list = next[event.channelId]
      if (!list) {
        continue
      }
      const { messageId, userId } = event.target
      if (messageId !== undefined) {
        next[event.channelId] = list.map((m) => (m.id === messageId ? markDeleted(m) : m))
      } else if (userId !== undefined) {
        next[event.channelId] = list.map((m) => (m.author.id === userId ? markDeleted(m) : m))
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
 * Mark a message deleted (moderator hid/removed it). Also clears any `held` review state: a held
 * message that's been deleted has been decided, so it should render as a struck "removed" line, not
 * keep its "awaiting review" card.
 */
function markDeleted(message: ChatMessage): ChatMessage {
  const { held: _held, ...rest } = message
  return { ...rest, deleted: true }
}

/**
 * Resolve a held-for-review row to its decided state right after a moderator acts on it, without
 * waiting for YouTube to echo the change back through polling: drop the `held` card and render the
 * message hidden (struck) or published (regular) per the chosen action. Idempotent — a later server
 * echo for the same id replaces the row in place consistently. Returns `prev` unchanged if the
 * message isn't buffered, or if `hides` is undefined — an unclassifiable action, left pending so the
 * server echo (a replace) resolves it rather than an optimistic guess.
 */
export function resolveHeldMessage(
  prev: MessageMap,
  channelId: string,
  messageId: string,
  hides: boolean | undefined
): MessageMap {
  if (hides === undefined) {
    return prev
  }
  const list = prev[channelId]
  if (list === undefined || !list.some((m) => m.id === messageId && m.held !== undefined)) {
    return prev
  }
  return {
    ...prev,
    [channelId]: list.map((m) => {
      if (m.id !== messageId) {
        return m
      }
      const { held: _held, ...rest } = m
      return { ...rest, deleted: hides }
    })
  }
}

/**
 * Insert a message at its chronological slot in an oldest-first buffer (newest last). Used for a
 * moderation-backlog row surfaced out of band (a held/hidden replace of an unbuffered message), so
 * it lands where it was sent instead of at the bottom. Scans from the end — the backlog is small and
 * its send time is usually near the tail it's reconciled against.
 */
function insertByTimestamp(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  let index = list.length
  while (index > 0 && (list[index - 1]?.timestamp ?? 0) > message.timestamp) {
    index -= 1
  }
  return [...list.slice(0, index), message, ...list.slice(index)]
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
