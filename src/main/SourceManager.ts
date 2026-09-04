import type {
  ChannelInfo,
  ChatAction,
  ChatEvent,
  ChatMessage,
  ClearTarget,
  Platform,
  SendReply,
  SourceStatus,
  UserModerationActivity,
  UserProfile
} from '@shared/model'
import { legacyStreamerKey } from '@shared/streamerKey'
import type { ChatSource } from '@main/sources/ChatSource'
import { channelId } from '@main/sources/channelId'

/** A source's emote identity: the platform + channel id its third-party emotes load under. */
export interface EmoteScope {
  platform: Platform
  channelId: string
}

/** Owns the set of active chat sources and fans their events out to one sink. */
export class SourceManager {
  readonly #sources = new Map<string, ChatSource>()
  readonly #labels = new Map<string, string>()
  readonly #detachers = new Map<string, () => void>()
  readonly #onEvent: (event: ChatEvent) => void
  readonly #onDuplicate: (channelId: string) => void
  readonly #onScopeReleased: (scope: EmoteScope) => void
  readonly #onIdentityResolved: (
    sourceId: string,
    identity: { streamerKey: string; creatorId?: string }
  ) => void
  /** Source ids that have already reported a resolved identity, so it fires only once each. */
  /** The creator id last reported per source, so an owner change is reported again. */
  readonly #identityReported = new Map<string, string>()

  constructor(
    onEvent: (event: ChatEvent) => void,
    onDuplicate: (channelId: string) => void = () => {},
    onScopeReleased: (scope: EmoteScope) => void = () => {},
    onIdentityResolved: (
      sourceId: string,
      identity: { streamerKey: string; creatorId?: string }
    ) => void = () => {}
  ) {
    this.#onEvent = onEvent
    this.#onDuplicate = onDuplicate
    this.#onScopeReleased = onScopeReleased
    this.#onIdentityResolved = onIdentityResolved
  }

  async add(source: ChatSource, label: string): Promise<void> {
    this.#sources.set(source.id, source)
    this.#labels.set(source.id, label)
    // Keep references to detach on remove/dispose, so a late event from an in-flight
    // operation on a removed source can't reach the renderer.
    const onMessage = (message: ChatMessage): void => {
      this.#onEvent({ kind: 'message', channelId: source.id, message })
    }
    const onReplace = (message: ChatMessage): void => {
      this.#onEvent({ kind: 'replace', channelId: source.id, message })
    }
    const onStatus = (status: SourceStatus): void => {
      this.#onEvent({ kind: 'status', channelId: source.id, status })
      this.#reportIdentityIfResolved(source)
    }
    const onClear = (target: ClearTarget): void => {
      this.#onEvent({ kind: 'clear', channelId: source.id, target })
    }
    const onRestriction = (reason: string | undefined): void => {
      this.#onEvent({ kind: 'sendRestriction', channelId: source.id, reason })
    }
    const onResolved = (videoId: string): void => {
      this.#dedupeResolved(videoId)
    }
    // Relabel the channel to the resolved stream title (a `@handle` column otherwise shows the bare
    // handle, which reads like a chatter in the monitor's origin tag), and re-announce the list.
    const onTitle = (title: string): void => {
      this.#reportIdentityIfResolved(source)
      if (this.#labels.get(source.id) === title) {
        return
      }
      this.#labels.set(source.id, title)
      this.#onEvent({ kind: 'channels', channels: this.list() })
    }
    const onAuthorUpdate = (login: string, avatarUrl: string): void => {
      this.#onEvent({ kind: 'authorUpdate', channelId: source.id, login, avatarUrl })
    }
    source.on('message', onMessage)
    source.on('replace', onReplace)
    source.on('status', onStatus)
    source.on('clear', onClear)
    source.on('restriction', onRestriction)
    source.on('resolved', onResolved)
    source.on('title', onTitle)
    source.on('authorUpdate', onAuthorUpdate)
    this.#detachers.set(source.id, () => {
      source.off('message', onMessage)
      source.off('replace', onReplace)
      source.off('status', onStatus)
      source.off('clear', onClear)
      source.off('restriction', onRestriction)
      source.off('resolved', onResolved)
      source.off('title', onTitle)
      source.off('authorUpdate', onAuthorUpdate)
    })
    // Announce the new channel so the renderer picks up sources added after its
    // initial snapshot (e.g. YouTube, which connects a few seconds later).
    this.#onEvent({ kind: 'channels', channels: this.list() })
    // Connect in the background: a slow handshake (or a stalled debug proxy) must not
    // block add() and thus startup restore or the add-channel form. Failures surface as status.
    void source.connect().catch((error: unknown) => {
      // The source may have been removed (and the id possibly re-added with a new source)
      // while connect was pending; don't report a stale failure against the current channel.
      if (this.#sources.get(source.id) !== source) {
        return
      }
      this.#onEvent({
        kind: 'status',
        channelId: source.id,
        status: {
          state: 'error',
          message: error instanceof Error ? error.message : 'Failed to connect'
        }
      })
    })
  }

  list(): ChannelInfo[] {
    return [...this.#sources.values()].map((source) => {
      const info: ChannelInfo = {
        id: source.id,
        platform: source.platform,
        label: this.#labels.get(source.id) ?? source.id,
        status: source.status(),
        streamerKey: source.streamerKey?.() ?? legacyStreamerKey(source.id)
      }
      const restriction = source.sendRestriction?.()
      if (restriction !== undefined) {
        info.sendRestriction = restriction
      }
      const creatorId = source.creator?.()?.channelId
      if (creatorId !== undefined) {
        info.creatorId = creatorId
      }
      return info
    })
  }

  has(sourceId: string): boolean {
    return this.#sources.has(sourceId)
  }

  /** The emote scope (platform + channel id) for a source, if it has resolved one. */
  emoteScope(sourceId: string): { platform: Platform; channelId: string } | undefined {
    return this.#sources.get(sourceId)?.emoteScope?.()
  }

  /** A registered source's cross-platform streamer key, or undefined if it isn't registered. */
  streamerKeyOf(sourceId: string): string | undefined {
    const source = this.#sources.get(sourceId)
    return source === undefined
      ? undefined
      : (source.streamerKey?.() ?? legacyStreamerKey(source.id))
  }

  /** A YouTube source's resolved creator channel id, or undefined if not registered/resolved. */
  creatorIdOf(sourceId: string): string | undefined {
    return this.#sources.get(sourceId)?.creator?.()?.channelId
  }

  /**
   * Report a source's resolved cross-platform identity to {@link #onIdentityResolved}, once, the
   * first time its creator becomes known (YouTube only — other sources never expose `creator()`).
   */
  /** The streamer key a source reports today, for columns added on its behalf. */
  streamerKeyFor(sourceId: string): string | undefined {
    const source = this.#sources.get(sourceId)
    if (source === undefined) {
      return undefined
    }
    return source.streamerKey?.() ?? legacyStreamerKey(source.id)
  }

  #reportIdentityIfResolved(source: ChatSource): void {
    const creator = source.creator?.()
    if (creator === undefined) {
      return
    }
    const streamerKey = source.streamerKey?.() ?? legacyStreamerKey(source.id)
    // Creator and key together: the same creator can gain a better key (the handle resolving after
    // a name-derived key was stored), and that must reach the config too.
    const mark = `${creator.channelId} ${streamerKey}`
    if (this.#identityReported.get(source.id) === mark) {
      return
    }
    this.#identityReported.set(source.id, mark)
    this.#onIdentityResolved(source.id, { streamerKey, creatorId: creator.channelId })
    // The renderer learns creatorId only through a channels event, and status changes don't send
    // one — re-announce so a video-id column's tab menu stops waiting on "resolving…".
    this.#onEvent({ kind: 'channels', channels: this.list() })
  }

  /** Video ids currently open across YouTube sources (a `@handle` column resolves to one too). */
  youtubeVideoIds(): Set<string> {
    const ids = new Set<string>()
    for (const source of this.#sources.values()) {
      if (source.platform === 'youtube') {
        const videoId = source.resolvedVideoId?.()
        if (videoId !== undefined) {
          ids.add(videoId)
        }
      }
    }
    return ids
  }

  /**
   * A YouTube source resolved to `videoId`. If more than one column is now on that video — a
   * standalone `youtube:<videoId>` column (a waiting room added by "add all streams") plus a
   * following column (e.g. a `@handle` column that just rolled to the next stream), or two
   * follower columns for the same creator added in different forms — remove the duplicates so
   * the chat isn't shown twice. The standalone column is always the one dropped; among followers
   * the first-added one is kept.
   */
  #dedupeResolved(videoId: string): void {
    const standaloneId = channelId('youtube', videoId)
    const onVideo = [...this.#sources.values()].filter(
      (source) =>
        source.platform === 'youtube' &&
        (source.id === standaloneId || source.resolvedVideoId?.() === videoId)
    )
    if (onVideo.length < 2) {
      return
    }
    const keep = onVideo.find((source) => source.id !== standaloneId)
    for (const source of onVideo) {
      if (source !== keep) {
        this.#onDuplicate(source.id)
      }
    }
  }

  /** Disconnect and remove a single source, then tell the renderer the new channel list. */
  async remove(sourceId: string): Promise<void> {
    const source = this.#sources.get(sourceId)
    if (source === undefined) {
      return
    }
    const scope = source.emoteScope?.()
    await source.disconnect()
    this.#detachers.get(sourceId)?.()
    this.#detachers.delete(sourceId)
    this.#sources.delete(sourceId)
    this.#labels.delete(sourceId)
    this.#identityReported.delete(sourceId)
    // Release the scope only when no remaining source shares it (two columns can — e.g.
    // two streams of one YouTube channel), so the survivors keep their emotes.
    if (scope !== undefined && !this.#scopeInUse(scope)) {
      this.#onScopeReleased(scope)
    }
    this.#onEvent({ kind: 'channels', channels: this.list() })
  }

  #scopeInUse(scope: EmoteScope): boolean {
    for (const source of this.#sources.values()) {
      const other = source.emoteScope?.()
      if (other?.platform === scope.platform && other.channelId === scope.channelId) {
        return true
      }
    }
    return false
  }

  /** Re-check send eligibility for a platform's sources (e.g. after a YouTube login or channel switch). */
  refreshSendability(platform: Platform): void {
    for (const source of this.#sources.values()) {
      if (source.platform === platform) {
        source.refreshSendability?.()
      }
    }
  }

  /** Disconnect and reconnect every source of a platform (e.g. after Twitch login/logout). */
  async reconnectByPlatform(platform: Platform): Promise<void> {
    await this.#reconnectSources(
      [...this.#sources.values()].filter((source) => source.platform === platform)
    )
  }

  /**
   * Reconnect every registered source — the wake/watchdog recovery path (see {@link KeepAlive}). After
   * a sleep, both connectors' sockets are half-open and silently dead, so reconnecting discards them.
   */
  async reconnectAll(): Promise<void> {
    await this.#reconnectSources([...this.#sources.values()])
  }

  async #reconnectSources(sources: ChatSource[]): Promise<void> {
    for (const source of sources) {
      try {
        await source.disconnect()
        // The source may have been removed (remove() awaits its own disconnect) while this one was
        // disconnecting — don't reconnect a channel the user closed and leak its connection.
        if (this.#sources.get(source.id) !== source) {
          continue
        }
        await source.connect()
      } catch (error) {
        // One channel's failed handshake must not abandon the rest of the reconnects; surface the
        // failure on that column (unless it was removed meanwhile).
        if (this.#sources.get(source.id) !== source) {
          continue
        }
        this.#onEvent({
          kind: 'status',
          channelId: source.id,
          status: {
            state: 'error',
            message: error instanceof Error ? error.message : 'Failed to reconnect'
          }
        })
      }
    }
  }

  async send(channelId: string, text: string, reply?: SendReply): Promise<void> {
    const source = this.#sources.get(channelId)
    if (!source) {
      throw new Error(`No chat source registered for channel "${channelId}"`)
    }
    await source.send(text, reply)
  }

  /** Right-click actions available on a message (empty if the source/platform has none). */
  async getMessageActions(channelId: string, menuToken: string): Promise<ChatAction[]> {
    return (await this.#sources.get(channelId)?.getMessageActions?.(menuToken)) ?? []
  }

  async runMessageAction(
    channelId: string,
    menuToken: string,
    actionId: string,
    timeoutSeconds?: number
  ): Promise<void> {
    const source = this.#sources.get(channelId)
    if (source?.runMessageAction === undefined) {
      throw new Error('No chat actions available for this channel')
    }
    await source.runMessageAction(menuToken, actionId, timeoutSeconds)
  }

  async runHeldAction(channelId: string, token: string): Promise<void> {
    const source = this.#sources.get(channelId)
    if (source?.runHeldAction === undefined) {
      throw new Error('No chat actions available for this channel')
    }
    await source.runHeldAction(token)
  }

  /** A Super Chat's reply thread (donation + replies); empty if the source can't fetch one. */
  async getReplyThread(channelId: string, threadToken: string): Promise<ChatMessage[]> {
    return (await this.#sources.get(channelId)?.getReplyThread?.(threadToken)) ?? []
  }

  /** Platform profile details for an author (user card); undefined if the source can't fetch one. */
  async getUserProfile(channelId: string, userId: string): Promise<UserProfile | undefined> {
    return await this.#sources.get(channelId)?.getUserProfile?.(userId)
  }

  /** A moderator's channel-activity for an author (counts + history); undefined if the source can't fetch it. */
  async getUserModerationHistory(
    channelId: string,
    userId: string
  ): Promise<UserModerationActivity | undefined> {
    return await this.#sources.get(channelId)?.getUserModerationHistory?.(userId)
  }

  /** Re-fetch every source's native emotes (Twitch channel emotes, YouTube emoji catalogs). */
  async refreshEmotes(): Promise<void> {
    await Promise.all(
      [...this.#sources.values()].map((source) => source.refreshEmotes?.() ?? Promise.resolve())
    )
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.#sources.values()].map((source) => source.disconnect()))
    for (const detach of this.#detachers.values()) {
      detach()
    }
    this.#detachers.clear()
    this.#sources.clear()
    this.#labels.clear()
    this.#identityReported.clear()
  }
}
