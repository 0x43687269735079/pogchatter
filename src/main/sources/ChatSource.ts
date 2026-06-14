import { EventEmitter } from 'node:events'
import type {
  ChatAction,
  ChatMessage,
  ClearTarget,
  Platform,
  SourceStatus,
  UserProfile
} from '@shared/model'

export interface ChatSourceEventMap {
  message: [message: ChatMessage]
  /** Replace a buffered message in place, keyed by `message.id` (YouTube `replaceChatItemAction`). */
  replace: [message: ChatMessage]
  status: [status: SourceStatus]
  clear: [target: ClearTarget]
  /** The signed-in user's send eligibility changed (reason set = blocked, undefined = allowed). */
  restriction: [reason: string | undefined]
  /**
   * The source (re)resolved which video its chat reads (YouTube). Fires on first resolve and on each
   * change — e.g. a `@handle` column following a channel rolls to the next stream when the live one
   * ends — so the manager can drop a standalone column that now duplicates this one.
   */
  resolved: [videoId: string]
  /**
   * The title of the live/upcoming stream this chat belongs to (YouTube). Fires when it's first known
   * and whenever it changes (a stream roll), so the column/monitor label can show the stream title
   * instead of the bare `@handle` — which otherwise reads like a chatter in the monitor's origin tag.
   */
  title: [title: string]
  /**
   * An author's avatar became known after their messages were already emitted (Twitch resolves
   * avatars in a lazy batched lookup), so buffers can back-fill the earlier rows.
   */
  authorUpdate: [login: string, avatarUrl: string]
}

/**
 * A connection to one channel's chat on one platform.
 *
 * Implementations normalize their native payloads to {@link ChatMessage} and
 * surface lifecycle changes via {@link SourceStatus}. The Twitch source is
 * effectively always-on; the YouTube source wraps a lifecycle state machine.
 */
export interface ChatSource {
  readonly id: string
  readonly platform: Platform
  status(): SourceStatus
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Send a message as the authenticated user. `replyTo` is a native reply target where supported. Throws if unauthenticated. */
  send(text: string, replyTo?: string): Promise<void>
  /** The platform + channel id under which this source's custom emotes are loaded, once known. */
  emoteScope?(): { platform: Platform; channelId: string } | undefined
  /** The video id this source is currently reading, once resolved (YouTube). Used to dedup streams. */
  resolvedVideoId?(): string | undefined
  /** Why the signed-in user currently can't send here, if the platform reports a restriction. */
  sendRestriction?(): string | undefined
  /** Re-check send eligibility (e.g. after login or a channel switch changes the identity). */
  refreshSendability?(): void
  /** Right-click actions available on a message for the signed-in account (report/block/moderation). */
  getMessageActions?(menuToken: string): Promise<ChatAction[]>
  /** Run one of {@link getMessageActions}'s actions; throws on failure. `timeoutSeconds` sets a timeout's duration. */
  runMessageAction?(menuToken: string, actionId: string, timeoutSeconds?: number): Promise<void>
  /** Run a held-for-review message's inline action (its opaque token); throws on failure. */
  runHeldAction?(token: string): Promise<void>
  /** A Super Chat's reply thread (the donation then its replies) for the token on a reply's context. */
  getReplyThread?(threadToken: string): Promise<ChatMessage[]>
  /** Platform profile details for an author seen in this chat (user card); undefined when unavailable. */
  getUserProfile?(userId: string): Promise<UserProfile | undefined>
  on<E extends keyof ChatSourceEventMap>(
    event: E,
    listener: (...args: ChatSourceEventMap[E]) => void
  ): void
  off<E extends keyof ChatSourceEventMap>(
    event: E,
    listener: (...args: ChatSourceEventMap[E]) => void
  ): void
}

/** Shared event plumbing and status tracking for concrete sources. */
export abstract class BaseChatSource implements ChatSource {
  abstract readonly id: string
  abstract readonly platform: Platform

  protected readonly emitter = new EventEmitter()
  protected currentStatus: SourceStatus = { state: 'offline' }
  #sendRestriction: string | undefined

  status(): SourceStatus {
    return this.currentStatus
  }

  sendRestriction(): string | undefined {
    return this.#sendRestriction
  }

  /** Record (and broadcast, on change) why the signed-in user can't send here — or that they can. */
  protected setSendRestriction(reason: string | undefined): void {
    if (reason === this.#sendRestriction) {
      return
    }
    this.#sendRestriction = reason
    this.emitter.emit('restriction', reason)
  }

  on<E extends keyof ChatSourceEventMap>(
    event: E,
    listener: (...args: ChatSourceEventMap[E]) => void
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
  }

  off<E extends keyof ChatSourceEventMap>(
    event: E,
    listener: (...args: ChatSourceEventMap[E]) => void
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
  }

  protected emitMessage(message: ChatMessage): void {
    this.emitter.emit('message', message)
  }

  /** Replace a buffered message in place by id (YouTube held-message approve/hide, edits). */
  protected emitReplace(message: ChatMessage): void {
    this.emitter.emit('replace', message)
  }

  protected setStatus(status: SourceStatus): void {
    // Sources re-derive their status on poll cycles (e.g. YouTube's 30s waiting-room poll), so an
    // unchanged status would otherwise be re-emitted forever. Statuses are tiny flat objects built
    // from literals with stable key order, so JSON comparison is an adequate deep-equal. Sources
    // that need a re-broadcast (reconnect flows) pass through 'connecting' first, so none is lost.
    if (JSON.stringify(status) === JSON.stringify(this.currentStatus)) {
      return
    }
    this.currentStatus = status
    this.emitter.emit('status', status)
  }

  protected emitClear(target: ClearTarget): void {
    this.emitter.emit('clear', target)
  }

  /** Announce the video id this source is now reading (YouTube), for cross-source de-duplication. */
  protected emitResolved(videoId: string): void {
    this.emitter.emit('resolved', videoId)
  }

  /** Announce the current stream's title (YouTube), for the column/monitor label. */
  protected emitTitle(title: string): void {
    this.emitter.emit('title', title)
  }

  /** Announce a lazily resolved author avatar, so already-buffered rows can be back-filled. */
  protected emitAuthorUpdate(login: string, avatarUrl: string): void {
    this.emitter.emit('authorUpdate', login, avatarUrl)
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract send(text: string, replyTo?: string): Promise<void>
}
