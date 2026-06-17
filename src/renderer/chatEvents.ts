import { BACKLOG_MESSAGES_PER_CHANNEL } from '@shared/model'
import type { AppSettings, AuthState, ChatEvent } from '@shared/model'
import { matchHighlight, messageText } from '@renderer/highlights'
import { isFlagged } from '@renderer/moderation'

/**
 * Seen-id capacity for {@link SeenMessageIds}: twice the buffer, floored at twice the backlog
 * replay size. With a small buffer (100), `bufferSize * 2` alone would be smaller than the
 * 300-message replay, so folding a busy channel's backlog would evict its own oldest ids within
 * one filter() call — and re-sent messages would then re-fire alerts right after a crash-reload.
 */
export function seenIdCapacity(bufferSize: number): number {
  return Math.max(bufferSize * 2, BACKLOG_MESSAGES_PER_CHANNEL * 2)
}

/**
 * Bounded per-channel memory of message ids already delivered, used to drop re-sent messages
 * (YouTube invalidation re-sends, reader-reconnect replays, backlog/live overlap) BEFORE the
 * alert policy runs — the in-buffer dedup in chatState protects only the rows, not the sounds,
 * flashes, notifications, or the msgs/sec counter. FIFO eviction at `capacity` ids per channel.
 */
export class SeenMessageIds {
  readonly #byChannel = new Map<string, Set<string>>()

  /**
   * `events` without messages whose id was already seen, recording the new ones. A whole-chat
   * clear forgets the channel (a post-clear re-send may re-enter, matching the buffer); a
   * channels event drops state for removed channels.
   */
  filter(events: ChatEvent[], capacity: number): ChatEvent[] {
    const kept: ChatEvent[] = []
    for (const event of events) {
      if (event.kind === 'message') {
        const ids = this.#idsFor(event.channelId)
        if (ids.has(event.message.id)) {
          continue
        }
        this.#remember(ids, event.message.id, capacity)
      } else if (event.kind === 'replace') {
        // A replace can surface an unbuffered held/hidden row (the standing moderation backlog), so
        // record its id — otherwise a later same-id `message` would pass the filter and the alert
        // pipeline would count/sound/notify for a row that's already shown.
        if (event.message.held !== undefined || event.message.deleted === true) {
          this.#remember(this.#idsFor(event.channelId), event.message.id, capacity)
        }
      } else if (event.kind === 'clear') {
        if (event.target.messageId === undefined && event.target.userId === undefined) {
          this.#byChannel.delete(event.channelId)
        }
      } else if (event.kind === 'channels') {
        const present = new Set(event.channels.map((channel) => channel.id))
        for (const channelId of this.#byChannel.keys()) {
          if (!present.has(channelId)) {
            this.#byChannel.delete(channelId)
          }
        }
      }
      kept.push(event)
    }
    return kept
  }

  #idsFor(channelId: string): Set<string> {
    let ids = this.#byChannel.get(channelId)
    if (ids === undefined) {
      ids = new Set()
      this.#byChannel.set(channelId, ids)
    }
    return ids
  }

  /** Record `id` as seen, evicting the oldest ids past `capacity` (FIFO). */
  #remember(ids: Set<string>, id: string, capacity: number): void {
    ids.add(id)
    while (ids.size > capacity) {
      const oldest = ids.values().next().value
      if (oldest === undefined) {
        break
      }
      ids.delete(oldest)
    }
  }
}

/** What a batch of chat events asks the shell to apply: counter/state updates and alert effects. */
export interface ProcessedEvents {
  /** New chat messages in the batch (feeds the status-bar msgs/sec counter). */
  added: number
  /** Channels whose column should flash (a highlight with flash on, or any watchlist hit). */
  flashed: Set<string>
  /** Play the ping sound once for the batch. */
  sound: boolean
  /**
   * OS-notification payload for the batch's last notifying hit: a `★` highlight (rule notify on)
   * or a `⚑` watchlist flag (moderation notify on). A message hitting both notifies as `⚑`.
   */
  notify: { title: string; body: string } | undefined
  /** The latest auth snapshot in the batch, if any auth event arrived. */
  auth: AuthState | undefined
}

/**
 * The per-batch ingestion policy: tag each message with its highlight colour and watchlist flag,
 * and collect the alerts (column flashes, sound, OS notification) the batch should trigger.
 *
 * Tags are written onto `event.message` in place (`ping`, `flagged`) — `applyEventsToMessages`
 * buffers that same object, so the tags render without another pass. Non-message events are passed
 * through untouched; the last `auth` event's state is surfaced for the shell to apply.
 */
export function processEvents(events: ChatEvent[], settings: AppSettings): ProcessedEvents {
  let added = 0
  let sound = false
  let notify: { title: string; body: string } | undefined
  let auth: AuthState | undefined
  const flashed = new Set<string>()
  for (const event of events) {
    if (event.kind === 'message') {
      added += 1
      // Tag the message with its highlight colour (so it renders highlighted) and collect alerts.
      const hit = matchHighlight(event.message, settings.highlights)
      if (hit !== undefined) {
        event.message.ping = { color: hit.color }
        if (hit.flash) {
          flashed.add(event.channelId)
        }
        sound ||= hit.sound
        if (hit.notify) {
          notify = {
            title: `★ ${event.message.author.displayName}`,
            body: messageText(event.message)
          }
        }
      }
      // Flag a message that trips the moderation watchlist, and alert so a mod reviews it.
      const moderation = settings.moderation
      if (isFlagged(event.message, moderation.rules)) {
        event.message.flagged = true
        flashed.add(event.channelId)
        sound ||= moderation.sound
        if (moderation.notify) {
          notify = {
            title: `⚑ ${event.message.author.displayName}`,
            body: messageText(event.message)
          }
        }
      }
    } else if (event.kind === 'auth') {
      auth = event.auth
    }
  }
  return { added, flashed, sound, notify, auth }
}
