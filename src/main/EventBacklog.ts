import { BACKLOG_MESSAGES_PER_CHANNEL } from '@shared/model'
import type { ChatEvent, ChatMessage, ClearTarget } from '@shared/model'

/**
 * Bounded per-channel ring of the chat already sent to the renderer, replayed via
 * `chat:getBacklog` so a fresh renderer (startup race, crash-reload) refills its buffers instead
 * of opening empty. Clears are applied in place — deletions marked, whole-chat wipes emptied — so
 * the snapshot is plain message events the renderer folds through its normal path; channel
 * removals prune the ring via the same `channels` events the renderer sees.
 */
export class EventBacklog {
  readonly #byChannel = new Map<string, ChatMessage[]>()

  record(event: ChatEvent): void {
    if (event.kind === 'message') {
      const list = this.#byChannel.get(event.channelId) ?? []
      list.push(event.message)
      if (list.length > BACKLOG_MESSAGES_PER_CHANNEL) {
        list.splice(0, list.length - BACKLOG_MESSAGES_PER_CHANNEL)
      }
      this.#byChannel.set(event.channelId, list)
    } else if (event.kind === 'replace') {
      this.#applyReplace(event.channelId, event.message)
    } else if (event.kind === 'clear') {
      this.#applyClear(event.channelId, event.target)
    } else if (event.kind === 'authorUpdate') {
      // Back-fill the retained ring like the renderer back-fills its buffers, so a replayed
      // history doesn't resurrect the placeholder avatars the live view already healed.
      const list = this.#byChannel.get(event.channelId)
      if (list !== undefined) {
        this.#byChannel.set(
          event.channelId,
          list.map((m) =>
            m.author.name === event.login && m.author.avatarUrl === undefined
              ? { ...m, author: { ...m.author, avatarUrl: event.avatarUrl } }
              : m
          )
        )
      }
    } else if (event.kind === 'channels') {
      const present = new Set(event.channels.map((channel) => channel.id))
      for (const channelId of this.#byChannel.keys()) {
        if (!present.has(channelId)) {
          this.#byChannel.delete(channelId)
        }
      }
    }
  }

  /** The retained history as message events, per channel in arrival order. */
  snapshot(): ChatEvent[] {
    const events: ChatEvent[] = []
    for (const [channelId, list] of this.#byChannel) {
      for (const message of list) {
        events.push({ kind: 'message', channelId, message })
      }
    }
    return events
  }

  /**
   * Apply a YouTube `replaceChatItemAction` to the retained ring, mirroring the renderer
   * ({@link applyEventsToMessages}): update a buffered id in place (a held card decided to
   * approved/hidden), so a replay shows its decided state rather than the stale pending card; retain
   * an unbuffered held or hidden replacement (the standing moderation backlog, whose original add
   * predates this ring) so it isn't lost; ignore a plain unbuffered approved/edited replacement
   * (nothing to moderate). Retained held items re-sort into chat order on replay (the renderer folds
   * the snapshot's `message` events through its by-timestamp insert).
   */
  #applyReplace(channelId: string, message: ChatMessage): void {
    const list = this.#byChannel.get(channelId)
    if (list?.some((m) => m.id === message.id) === true) {
      this.#byChannel.set(
        channelId,
        list.map((m) => (m.id === message.id ? message : m))
      )
      return
    }
    if (message.held === undefined && message.deleted !== true) {
      return
    }
    const next = list ?? []
    next.push(message)
    if (next.length > BACKLOG_MESSAGES_PER_CHANNEL) {
      next.splice(0, next.length - BACKLOG_MESSAGES_PER_CHANNEL)
    }
    this.#byChannel.set(channelId, next)
  }

  #applyClear(channelId: string, target: ClearTarget): void {
    const list = this.#byChannel.get(channelId)
    if (list === undefined) {
      return
    }
    const { messageId, userId } = target
    if (messageId !== undefined) {
      this.#byChannel.set(
        channelId,
        list.map((m) => (m.id === messageId ? { ...m, deleted: true } : m))
      )
    } else if (userId !== undefined) {
      this.#byChannel.set(
        channelId,
        list.map((m) => (m.author.id === userId ? { ...m, deleted: true } : m))
      )
    } else {
      this.#byChannel.delete(channelId)
    }
  }
}
