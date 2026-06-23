import { ApiClient } from '@twurple/api'
import { ChatClient, type ChatClientOptions } from '@twurple/chat'
import type { ChatAction, ChatMessage, Platform, SendReply, UserProfile } from '@shared/model'
import { BaseChatSource } from '@main/sources/ChatSource'
import { channelId, normalizeTarget } from '@main/sources/channelId'
import {
  decodeTwitchMenuToken,
  normalizeTwitchCommunitySub,
  normalizeTwitchMessage,
  normalizeTwitchSub,
  normalizeTwitchSubGift,
  type NormalizeOptions,
  type TwitchMenuContext
} from '@main/sources/twitch/normalize'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import { TwitchAvatarProvider } from '@main/sources/twitch/TwitchAvatarProvider'
import { TwitchRewardProvider } from '@main/sources/twitch/TwitchRewardProvider'
import type { HelixFetch, TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import type { TwitchBadgeProvider } from '@main/sources/twitch/TwitchBadgeProvider'
import type { TwitchCheermoteProvider } from '@main/sources/twitch/TwitchCheermoteProvider'
import type { TwitchEmoteProvider } from '@main/sources/twitch/TwitchEmoteProvider'

interface Unbindable {
  unbind(): void
}

/** The Helix art/catalog providers shared by every Twitch source. */
export interface TwitchHelixProviders {
  badges: TwitchBadgeProvider
  emotes: TwitchEmoteProvider
  cheermotes: TwitchCheermoteProvider
}

/** How often to ask Helix whether the stream is live, plus per-cycle jitter so columns spread out. */
const LIVE_POLL_MS = 60_000
const LIVE_POLL_JITTER_MS = 5_000

/**
 * Cap on a say() round trip: twurple parks sends in a rate limiter that pauses while disconnected
 * and drops its queue on the next drop without settling the promises, which would otherwise hang
 * the renderer's IPC call forever.
 */
const SEND_TIMEOUT_MS = 10_000

/**
 * quit() can't cancel twurple's pending internal auth-retry (`await delay(...)` then
 * `_ircClient.reconnect()` in its NOTICE handler), which silently revives a quit client as a live
 * IRC connection. The retries are a *chain* — each failed revival schedules the next, with
 * fibonacci delays capped at 120s — so a single re-quit can land while the client sits
 * disconnected inside a pending delay and miss the next revival. Re-quit every 125s (just past
 * the longest delay) a few times; a quit that lands while connected ends the chain.
 */
const ORPHAN_REQUIT_MS = 125_000
const ORPHAN_REQUIT_LIMIT = 5

/** Remembered community-gift batch ids (each one suppresses its per-recipient notice spam). */
const COMMUNITY_GIFT_IDS_MAX = 200

/**
 * The moderation actions Twitch offers a moderator/broadcaster, each a distinct Helix call (there
 * is no per-message menu endpoint like YouTube's, and report/block have no public API). The
 * timeout durations mirror Twitch's own web-client presets (10s … 1 day).
 */
const MOD_ACTIONS: ChatAction[] = [
  { id: 'remove', label: 'Remove message', destructive: true },
  {
    id: 'timeout',
    label: 'Timeout user',
    destructive: true,
    timeoutDurations: [10, 60, 600, 1800, 3600, 86400]
  },
  { id: 'ban', label: 'Ban user', destructive: true }
]

/** Map a failed Helix moderation call to a user-facing error. */
function actionError(error: unknown, label: string): Error {
  // twurple's HttpStatusCodeError; duck-typed so @twurple/api-call isn't a direct dependency.
  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (statusCode === 401 || statusCode === 403) {
    // Keep the status on the user-facing error: AutoMod reads it to tell a permanent
    // permission failure (stop retrying) from a transient one.
    return Object.assign(
      new Error(
        `Twitch refused the ${label} (${statusCode}) — log out and back in to Twitch to grant ` +
          'the moderation permissions, and check that your account mods this channel'
      ),
      { statusCode }
    )
  }
  return new Error(
    `Twitch ${label} failed: ${error instanceof Error ? error.message : String(error)}`
  )
}

/**
 * Reads a Twitch channel's chat over IRC. Connects anonymously (read-only) when
 * logged out, or authenticated (read + send) once {@link TwitchAuthManager} has
 * credentials. Reconnect after login to switch modes.
 */
export class TwitchSource extends BaseChatSource {
  readonly id: string
  readonly platform: Platform = 'twitch'
  readonly #login: string
  readonly #emotes: EmoteEngine
  readonly #auth: TwitchAuthManager
  readonly #badges: TwitchBadgeProvider
  readonly #twitchEmotes: TwitchEmoteProvider
  readonly #cheermotes: TwitchCheermoteProvider
  #client: ChatClient | undefined
  #listeners: Unbindable[] = []
  #roomId: string | undefined
  #echoCount = 0
  #api: ApiClient | undefined
  // Whether disconnect() initiated the current quit — a "manual" disconnect we didn't ask for is
  // twurple quitting internally (e.g. after an IRC password error) and must surface as an error.
  #intentionalQuit = false
  // One re-login hint per connect when the Helix mod check is rejected for missing scopes.
  #modScopeNoticeShown = false
  // Whether the logged-in user mods this channel, resolved once per login (keyed by user id;
  // shared as a promise so concurrent right-clicks don't race duplicate Helix lookups).
  #modStatus: { userId: string; isMod: Promise<boolean> } | undefined
  readonly #avatars = new TwitchAvatarProvider(
    () => this.#apiClient(),
    // Avatars resolve after the author's first messages already rendered; announce each one so
    // the buffered rows get back-filled instead of keeping the placeholder forever.
    (login, avatarUrl) => {
      this.emitAuthorUpdate(login, avatarUrl)
    }
  )
  // Channel-points reward names (UUID → title) for this channel, read once from Twitch's public
  // GraphQL catalog since IRC carries only the reward id. Anonymous; no auth needed.
  readonly #rewards = new TwitchRewardProvider()
  // Announced community-gift batch ids — Twitch follows "X is gifting N subs" with N individual
  // gift notices carrying the same msg-param-community-gift-id, which would spam the column.
  // Bounded so a very long session can't grow it unboundedly.
  readonly #announcedCommunityGifts = new Set<string>()
  // Latest Helix stream-live poll result; undefined = not live (or never polled / logged out).
  #live: { viewers: number } | undefined
  #liveTimer: NodeJS.Timeout | undefined
  // Bumped on every connect/disconnect so a stale poll chain (or in-flight call) stops itself.
  #pollGeneration = 0

  constructor(
    login: string,
    emotes: EmoteEngine,
    auth: TwitchAuthManager,
    helix: TwitchHelixProviders
  ) {
    super()
    this.#login = normalizeTarget('twitch', login)
    this.#emotes = emotes
    this.#auth = auth
    this.#badges = helix.badges
    this.#twitchEmotes = helix.emotes
    this.#cheermotes = helix.cheermotes
    this.id = channelId('twitch', login)
  }

  async connect(): Promise<void> {
    this.setStatus({ state: 'connecting' })
    this.#intentionalQuit = false
    this.#modScopeNoticeShown = false
    this.#announcedCommunityGifts.clear()
    const options: ChatClientOptions = { channels: [this.#login] }
    const provider = this.#auth.getAuthProvider()
    if (provider !== undefined) {
      options.authProvider = provider
    }
    const client = new ChatClient(options)
    this.#client = client
    void this.#loadBadges()
    // Pre-load the reward catalog by login (available upfront, unlike the numeric room id) so a
    // redemption message can be named the moment it arrives.
    void this.#rewards.ensureChannel(this.#login)

    this.#listeners = [
      client.onConnect(() => {
        this.#setConnected()
      }),
      client.onJoin((channel) => {
        if (this.#matches(channel)) {
          this.#setConnected()
        }
      }),
      client.onJoinFailure((channel, reason) => {
        if (this.#matches(channel)) {
          this.setStatus({ state: 'error', message: `Join failed: ${reason}` })
        }
      }),
      client.onDisconnect((manually, reason) => {
        if (manually && this.#intentionalQuit) {
          this.setStatus({ state: 'offline' })
        } else if (manually) {
          // ircv3 quits on its own after an IRC password error and never retries — keep a more
          // specific auth error already on the column (onTokenFetchFailure fires first).
          if (this.currentStatus.state !== 'error') {
            this.setStatus({
              state: 'error',
              message: reason?.message ?? 'Twitch closed the connection — try logging in again'
            })
          }
        } else if (reason) {
          this.setStatus({ state: 'error', message: reason.message })
        } else {
          this.setStatus({ state: 'connecting' })
        }
      }),
      client.onMessage((channel, _user, text, msg) => {
        if (!this.#matches(channel)) {
          return
        }
        const roomId = msg.channelId ?? undefined
        if (roomId !== undefined && roomId !== this.#roomId) {
          this.#roomId = roomId
          this.#emotes.ensureChannel('twitch', roomId)
          void this.#loadChannelBadges(roomId)
          void this.#loadChannelEmotes(roomId)
        }
        const message = normalizeTwitchMessage(this.id, text, msg, this.#normalizeOptions())
        message.fragments = this.#emotes.tokenize(message.fragments, 'twitch', this.#roomId)
        this.emitMessage(message)
      }),
      client.onSub((channel, _user, subInfo, msg) => {
        if (this.#matches(channel)) {
          this.#emitUserNotice(
            normalizeTwitchSub(this.id, subInfo, msg, 'sub', this.#normalizeOptions())
          )
        }
      }),
      client.onResub((channel, _user, subInfo, msg) => {
        if (this.#matches(channel)) {
          this.#emitUserNotice(
            normalizeTwitchSub(this.id, subInfo, msg, 'resub', this.#normalizeOptions())
          )
        }
      }),
      client.onSubGift((channel, _user, subInfo, msg) => {
        if (!this.#matches(channel)) {
          return
        }
        // Part of an announced community gift: the batch line already represents it. Twitch
        // tags a batch's per-recipient notices with the announcement's
        // msg-param-community-gift-id, so matching by id never swallows a genuine standalone
        // gift — counting would, whenever a reconnect ate part of a batch.
        const batchId = msg.tags.get('msg-param-community-gift-id')
        if (batchId !== undefined && this.#announcedCommunityGifts.has(batchId)) {
          return
        }
        this.#emitUserNotice(
          normalizeTwitchSubGift(this.id, subInfo, msg, this.#normalizeOptions())
        )
      }),
      client.onCommunitySub((channel, _user, subInfo, msg) => {
        if (!this.#matches(channel)) {
          return
        }
        const batchId = msg.tags.get('msg-param-community-gift-id')
        if (batchId !== undefined) {
          this.#rememberCommunityGift(batchId)
        }
        this.#emitUserNotice(
          normalizeTwitchCommunitySub(this.id, subInfo, msg, this.#normalizeOptions())
        )
      }),
      client.onMessageRemove((channel, messageId) => {
        if (this.#matches(channel)) {
          this.emitClear({ messageId })
        }
      }),
      // CLEARCHAT: a ban/timeout purges the target user's lines; without a target, the whole chat.
      client.onTimeout((channel, _user, _duration, msg) => {
        if (!this.#matches(channel)) {
          return
        }
        const userId = msg.targetUserId
        if (userId !== null) {
          this.emitClear({ userId })
        }
      }),
      client.onBan((channel, _user, msg) => {
        if (!this.#matches(channel)) {
          return
        }
        const userId = msg.targetUserId
        if (userId !== null) {
          this.emitClear({ userId })
        }
      }),
      client.onChatClear((channel) => {
        if (this.#matches(channel)) {
          this.emitClear({})
        }
      }),
      // Twitch acknowledges sends only by rejecting them via NOTICE; surface those so the
      // optimistic local echo isn't mistaken for a delivered message.
      client.onMessageFailed((channel, reason) => {
        if (this.#matches(channel)) {
          this.#systemNotice(`Message not sent — ${reason}`)
        }
      }),
      client.onNoPermission((channel) => {
        if (this.#matches(channel)) {
          this.#systemNotice('Message not sent — no permission in this channel')
        }
      }),
      client.onMessageRatelimit((channel) => {
        if (this.#matches(channel)) {
          this.#systemNotice('Message not sent — rate limited, slow down')
        }
      }),
      client.onAuthenticationFailure((text) => {
        this.setStatus({ state: 'error', message: `Twitch auth failed: ${text}` })
        void this.#auth.handleAuthFailure()
      }),
      // Fires when the auth provider can't produce a token for the IRC password (e.g. revoked
      // tokens); ircv3 then quits without retrying, so surface it and poke the auth manager.
      client.onTokenFetchFailure((error) => {
        this.setStatus({ state: 'error', message: `Twitch auth failed: ${error.message}` })
        void this.#auth.handleAuthFailure()
      })
    ]

    client.connect()

    // Stream-live polling is Helix-backed, so logged-out columns keep the plain 'connected' chip.
    // connect() runs again after login (the reconnect flow), which starts the poll then.
    this.#pollGeneration += 1
    if (this.#auth.isLoggedIn) {
      void this.#pollLive(this.#pollGeneration)
    }
  }

  async disconnect(): Promise<void> {
    this.#intentionalQuit = true
    for (const listener of this.#listeners) {
      listener.unbind()
    }
    this.#listeners = []
    const client = this.#client
    this.#client = undefined
    if (client !== undefined) {
      client.quit()
      // See ORPHAN_REQUIT_MS: a pending internal auth-retry can revive this client after quit(),
      // and @twurple/chat 8.1.4 offers no teardown that cancels it — re-quit on an interval so a
      // revived orphan (whose retry chain a single re-quit can miss) doesn't hold an IRC
      // connection and hammer Twitch for the rest of the session.
      let requits = 0
      const requitTimer = setInterval(() => {
        requits += 1
        client.quit()
        if (requits >= ORPHAN_REQUIT_LIMIT) {
          clearInterval(requitTimer)
        }
      }, ORPHAN_REQUIT_MS)
      requitTimer.unref()
    }
    // Re-check the moderator role on the next connect (login changes reconnect the source).
    this.#modStatus = undefined
    this.#pollGeneration += 1
    if (this.#liveTimer !== undefined) {
      clearTimeout(this.#liveTimer)
      this.#liveTimer = undefined
    }
    this.#live = undefined
    this.#avatars.stop()
    this.setStatus({ state: 'offline' })
  }

  emoteScope(): { platform: Platform; channelId: string } | undefined {
    return this.#roomId === undefined ? undefined : { platform: 'twitch', channelId: this.#roomId }
  }

  async send(text: string, reply?: SendReply): Promise<void> {
    if (!this.#auth.isLoggedIn) {
      throw new Error('Log in to Twitch to send messages')
    }
    const client = this.#client
    if (client === undefined || !client.isConnected) {
      throw new Error('Not connected to Twitch — message not sent')
    }
    const replyTo = reply?.parentId
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Twitch send timed out — message not sent'))
      }, SEND_TIMEOUT_MS)
    })
    const delivery = client.say(this.#login, text, replyTo !== undefined ? { replyTo } : undefined)
    // The race below abandons `delivery` when the timeout wins, so observe it separately:
    // twurple's rate limiter can hold a send past the timeout and still deliver it, so a late
    // success echoes after all (otherwise the user resends a duplicate); a late rejection is
    // swallowed (the renderer already saw the timeout) so it never reaches unhandledRejection.
    void delivery.then(
      () => {
        if (timedOut) {
          this.#echo(text, reply)
        }
      },
      () => {}
    )
    try {
      await Promise.race([delivery, timeout])
    } finally {
      clearTimeout(timer)
    }
    // Twitch IRC doesn't echo your own messages back over your connection, so surface the sent
    // message locally. say() resolving only means the line was handed to the socket — Twitch
    // sends no positive ack, so this echo can still overstate delivery (rejections arrive later
    // as NOTICEs via the onMessageFailed/onNoPermission/onMessageRatelimit handlers above).
    this.#echo(text, reply)
  }

  /**
   * Right-click moderation actions for a message: remove / timeout / ban, offered only when the
   * signed-in account can moderate this channel — the broadcaster always can; anyone else per
   * Helix's moderated-channels list, cached per login. Empty when logged out or for viewers
   * (Twitch's report/block flows are web-only). Best-effort UI, like the YouTube menu.
   */
  async getMessageActions(menuToken: string): Promise<ChatAction[]> {
    let context: TwitchMenuContext
    try {
      context = decodeTwitchMenuToken(menuToken)
    } catch {
      return []
    }
    if (!(await this.#canModerate())) {
      return []
    }
    // Sub/gift cards come from USERNOTICEs, which Helix cannot delete — offer only the
    // user-targeted actions there.
    return context.noDelete === true
      ? MOD_ACTIONS.filter((action) => action.id !== 'remove')
      : MOD_ACTIONS
  }

  /**
   * Run one of {@link getMessageActions}'s actions via Helix: delete the message, or ban/time out
   * its author. Throws a user-facing Error on failure; a 401/403 means the stored login predates
   * the moderation scopes (or the role is gone), so it tells the user to log out and back in.
   */
  async runMessageAction(
    menuToken: string,
    actionId: string,
    timeoutSeconds?: number
  ): Promise<void> {
    const target = decodeTwitchMenuToken(menuToken)
    const userId = this.#auth.userId
    const api = this.#apiClient()
    if (userId === undefined || api === undefined) {
      throw new Error('Log in to Twitch to use moderation actions')
    }
    const label = MOD_ACTIONS.find((action) => action.id === actionId)?.label.toLowerCase()
    if (label === undefined) {
      throw new Error(`Unknown Twitch chat action "${actionId}"`)
    }
    // A ban with a duration is a timeout; without one it's permanent.
    const ban: { user: string; duration?: number } = { user: target.userId }
    if (actionId === 'timeout') {
      if (timeoutSeconds === undefined) {
        throw new Error('Pick a timeout duration')
      }
      ban.duration = timeoutSeconds
    }
    const roomId = await this.#ensureRoomId()
    if (roomId === undefined) {
      throw new Error(`Could not resolve the Twitch id for "${this.#login}" — try again`)
    }
    try {
      // Moderation endpoints read moderator_id from the calling user's context, so run as the
      // logged-in user (for the broadcaster the two ids simply coincide).
      await api.asUser(userId, async (ctx) => {
        if (actionId === 'remove') {
          await ctx.moderation.deleteChatMessages(roomId, target.messageId)
        } else {
          await ctx.moderation.banUser(roomId, ban)
        }
      })
    } catch (error) {
      throw actionError(error, `${label} for ${target.userLogin}`)
    }
  }

  /**
   * Platform profile for the user card, via Helix users: display name, login, avatar, account
   * creation date, bio, and channel URL. Logged-in only (Helix needs a user token); undefined when
   * the lookup fails. Follower count is omitted — Helix gates it behind a moderator-only endpoint.
   */
  async getUserProfile(userId: string): Promise<UserProfile | undefined> {
    const api = this.#auth.isLoggedIn ? this.#apiClient() : undefined
    if (api === undefined) {
      return undefined
    }
    try {
      const user = await api.users.getUserById(userId)
      if (user === null) {
        return undefined
      }
      const profile: UserProfile = {
        platform: 'twitch',
        userId: user.id,
        displayName: user.displayName,
        handle: user.name,
        url: `https://www.twitch.tv/${user.name}`,
        createdAt: user.creationDate.getTime()
      }
      if (user.profilePictureUrl !== '') {
        profile.avatarUrl = user.profilePictureUrl
      }
      if (user.description !== '') {
        profile.description = user.description
      }
      return profile
    } catch {
      // Best-effort, like the rest of the card — the renderer shows what it already has.
      return undefined
    }
  }

  /** The normalize context shared by chat messages and USERNOTICE events (subs/gifts). */
  #normalizeOptions(): NormalizeOptions {
    return {
      resolveBadge: (setId, version) => this.#badges.resolve(this.#roomId, setId, version),
      // Avatars are Helix-backed, so only resolve (and queue lookups) while logged in.
      resolveAvatar: this.#auth.isLoggedIn ? (login) => this.#avatars.resolve(login) : undefined,
      selfUserId: this.#auth.userId,
      cheermotes: {
        names: () => this.#cheermotes.names(this.#roomId),
        resolve: (name, bits) => this.#cheermotes.resolve(this.#roomId, name, bits)
      },
      resolveReward: (rewardId) => this.#rewards.resolve(this.#login, rewardId)
    }
  }

  /** Remember an announced batch id, keeping the set bounded across a very long session. */
  #rememberCommunityGift(batchId: string): void {
    this.#announcedCommunityGifts.add(batchId)
    if (this.#announcedCommunityGifts.size > COMMUNITY_GIFT_IDS_MAX) {
      const oldest = this.#announcedCommunityGifts.values().next().value
      if (oldest !== undefined) {
        this.#announcedCommunityGifts.delete(oldest)
      }
    }
  }

  /** Tokenize third-party emotes into a sub/gift notice's body and emit it like any message. */
  #emitUserNotice(message: ChatMessage): void {
    message.fragments = this.#emotes.tokenize(message.fragments, 'twitch', this.#roomId)
    this.emitMessage(message)
  }

  /** Report the joined room as live (with viewers) when the Helix poll says so, else plain connected. */
  #setConnected(): void {
    if (this.#live === undefined) {
      this.setStatus({ state: 'connected' })
    } else {
      this.setStatus({ state: 'live', viewers: this.#live.viewers })
    }
  }

  /**
   * Ask Helix whether the stream is live (IRC says nothing about stream state), apply the result,
   * and reschedule. The generation check stops a chain orphaned by disconnect()/reconnect.
   */
  async #pollLive(generation: number): Promise<void> {
    const api = this.#apiClient()
    if (api === undefined) {
      return
    }
    try {
      const stream = await api.streams.getStreamByUserName(this.#login)
      if (generation === this.#pollGeneration) {
        this.#live = stream === null ? undefined : { viewers: stream.viewers }
        this.#applyLiveStatus()
      }
    } catch {
      // Transient Helix failure — keep the current status and re-check next cycle.
    }
    if (generation === this.#pollGeneration) {
      this.#liveTimer = setTimeout(
        () => void this.#pollLive(generation),
        LIVE_POLL_MS + Math.random() * LIVE_POLL_JITTER_MS
      )
    }
  }

  /**
   * Flip the status between connected/live per the latest poll, emitting only on change. Anything
   * else (an error from a join failure, connecting, offline) wins — the join handlers re-report
   * the live state once the room settles.
   */
  #applyLiveStatus(): void {
    const status = this.currentStatus
    if (status.state === 'connected' && this.#live !== undefined) {
      this.setStatus({ state: 'live', viewers: this.#live.viewers })
    } else if (status.state === 'live') {
      if (this.#live === undefined) {
        this.setStatus({ state: 'connected' })
      } else if (status.viewers !== this.#live.viewers) {
        this.setStatus({ state: 'live', viewers: this.#live.viewers })
      }
    }
  }

  /** Whether the signed-in account can moderate this channel (broadcaster, or cached mod check). */
  async #canModerate(): Promise<boolean> {
    const userId = this.#auth.userId
    if (userId === undefined) {
      return false
    }
    if (this.#auth.userName?.toLowerCase() === this.#login) {
      return true
    }
    if (this.#modStatus?.userId !== userId) {
      this.#modStatus = { userId, isMod: this.#checkModStatus(userId) }
    }
    return this.#modStatus.isMod
  }

  /** Whether the user mods this channel, per Helix "Get Moderated Channels". */
  async #checkModStatus(userId: string): Promise<boolean> {
    try {
      const api = this.#apiClient()
      const roomId = await this.#ensureRoomId()
      if (api === undefined || roomId === undefined) {
        this.#modStatus = undefined
        return false
      }
      const channels = await api.moderation.getModeratedChannelsPaginated(userId).getAll()
      return channels.some((channel) => channel.id === roomId)
    } catch (error) {
      // A 401/403 means the stored login predates `user:read:moderated_channels` — without the
      // hint a real moderator just sees an empty menu with no way to discover the re-login fix.
      const statusCode = (error as { statusCode?: unknown }).statusCode
      if ((statusCode === 401 || statusCode === 403) && !this.#modScopeNoticeShown) {
        this.#modScopeNoticeShown = true
        this.#systemNotice(
          `Twitch refused the moderator check (${statusCode}) — log out and back in to Twitch ` +
            'to grant the moderation permissions'
        )
      }
      // Don't cache the failure — a transient error (or a re-login) gets a fresh check on the
      // next menu open.
      this.#modStatus = undefined
      return false
    }
  }

  /** Lazy Helix client for moderation calls, backed by the self-refreshing auth provider. */
  #apiClient(): ApiClient | undefined {
    if (this.#api === undefined) {
      const provider = this.#auth.getAuthProvider()
      if (provider === undefined) {
        return undefined
      }
      // The provider reads live manager state, so one client stays valid across token refreshes.
      this.#api = new ApiClient({ authProvider: provider })
    }
    return this.#api
  }

  /** A Helix fetcher bound to this source's auth manager (fresh token + one-shot 401/403 recovery). */
  #helix(): HelixFetch {
    return (url) => this.#auth.helixFetch(url)
  }

  /** Load Twitch badge images from Helix once logged in (global now; channel art when the room id is known). */
  async #loadBadges(): Promise<void> {
    if (!this.#auth.isLoggedIn) {
      return
    }
    const helix = this.#helix()
    await this.#badges.ensureGlobal(helix)
    await this.#cheermotes.ensureGlobal(helix)
    // Resolve the room id from Helix up front rather than waiting for the first message, so a
    // quiet channel (e.g. a Twitch streamer simulcasting on YouTube) still loads its emotes.
    await this.#ensureRoomId()
    if (this.#roomId !== undefined) {
      await this.#badges.ensureChannel(this.#roomId, helix)
      await this.#cheermotes.ensureChannel(this.#roomId, helix)
      void this.#loadChannelEmotes(this.#roomId)
    }
  }

  /** This channel's numeric user/room id, resolved (and remembered) via Helix on first need. */
  async #ensureRoomId(): Promise<string | undefined> {
    if (this.#roomId !== undefined) {
      return this.#roomId
    }
    const resolved = await this.#resolveRoomId()
    // A chat message may have set the id while the lookup was in flight; keep the first one.
    if (resolved !== undefined && this.#roomId === undefined) {
      this.#roomId = resolved
      this.#emotes.ensureChannel('twitch', resolved)
    }
    return this.#roomId
  }

  /** Look up this channel's numeric user/room id via Helix (needed by the emote providers). */
  async #resolveRoomId(): Promise<string | undefined> {
    try {
      const response = await this.#auth.helixFetch(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(this.#login)}`
      )
      if (response === undefined || !response.ok) {
        return undefined
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> }
      return body.data?.[0]?.id
    } catch {
      return undefined
    }
  }

  /**
   * Load this channel's badge art with a fresh Helix token — the room id can arrive hours after
   * connect (first message in a quiet channel), past the connect-time token's ~4h expiry.
   */
  async #loadChannelBadges(roomId: string): Promise<void> {
    const helix = this.#helix()
    await this.#badges.ensureChannel(roomId, helix)
    await this.#cheermotes.ensureChannel(roomId, helix)
  }

  /** Fetch this channel's Twitch native emotes into the engine (for the input picker). */
  async #loadChannelEmotes(roomId: string): Promise<void> {
    const emotes = await this.#twitchEmotes.fetchChannel(roomId, this.#helix())
    if (emotes.length > 0) {
      this.#emotes.setTwitchChannel(roomId, emotes)
    }
  }

  #echo(text: string, reply?: SendReply): void {
    const name = this.#auth.userName ?? 'you'
    this.#echoCount += 1
    const message: ChatMessage = {
      id: `echo-${this.id}-${this.#echoCount}-${Date.now()}`,
      platform: 'twitch',
      channelId: this.id,
      timestamp: Date.now(),
      self: true,
      author: {
        // The numeric Helix id, like every real message — so user-activity/monitoring/profile
        // lookups keyed on author.id also match your own lines.
        id: this.#auth.userId ?? name,
        name,
        displayName: name,
        badges: [],
        roles: { broadcaster: false, moderator: false }
      },
      fragments: this.#emotes.tokenize([{ type: 'text', text }], 'twitch', this.#roomId)
    }
    // Twitch echoes nothing back over the sender's connection, so carry the reply/thread context the
    // renderer supplied — the echoed line then renders as a threaded reply (quote + indicator).
    if (reply !== undefined) {
      message.reply = {
        parentId: reply.parentId,
        parentAuthor: reply.parentAuthor ?? '',
        parentText: reply.parentText ?? ''
      }
      if (reply.threadId !== undefined) {
        message.reply.threadId = reply.threadId
        if (reply.threadAuthor !== undefined) {
          message.reply.threadAuthor = reply.threadAuthor
        }
      }
    }
    this.emitMessage(message)
  }

  /** Surface an asynchronous Twitch send rejection (NOTICE) as a system line in the column. */
  #systemNotice(text: string): void {
    this.#echoCount += 1
    this.emitMessage({
      id: `notice-${this.id}-${this.#echoCount}-${Date.now()}`,
      platform: 'twitch',
      channelId: this.id,
      timestamp: Date.now(),
      author: {
        id: 'twitch-system',
        name: 'system',
        displayName: '⚠ Twitch',
        color: '#ff5c5c',
        badges: [],
        roles: { broadcaster: false, moderator: false }
      },
      fragments: [{ type: 'text', text }],
      system: true
    })
  }

  #matches(channel: string): boolean {
    return channel.replace(/^#/, '').toLowerCase() === this.#login
  }
}
