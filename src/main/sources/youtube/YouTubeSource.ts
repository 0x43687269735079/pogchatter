import type { Innertube, YT } from 'youtubei.js'
import type { ChatAction, ChatMessage, Platform, SourceStatus, UserProfile } from '@shared/model'
import { BaseChatSource } from '@main/sources/ChatSource'
import { channelId, normalizeTarget } from '@main/sources/channelId'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import { LiveChatReader } from '@main/sources/youtube/liveChatReader'
import { parseReplyThread } from '@main/sources/youtube/normalize'
import { liveUrl } from '@main/sources/youtube/urls'
import { emojiSendMap, toResolvedEmotes } from '@main/sources/youtube/youtubeEmoji'
import { YouTubeSignaler } from '@main/sources/youtube/YouTubeSignaler'
import type { YouTubeAuthManager } from '@main/sources/youtube/YouTubeAuthManager'

// The reverse-engineered push "signaler" drives a live chat's updates in real time, with
// adaptive polling as the fallback. On by default; it's best-effort, so any failure just leaves the
// poller in charge. Set POGCHATTER_YT_SIGNALER_DEBUG=1 to log its lifecycle to stdout.
const SIGNALER_DEBUG = process.env['POGCHATTER_YT_SIGNALER_DEBUG'] === '1'

const OFFLINE_POLL_MS = 60_000
const ENDED_POLL_MS = 120_000
const STATUS_POLL_MS = 30_000
// Once the announced start is reached (or passed), check this often until the stream is actually live.
const IMMINENT_POLL_MS = 5_000
// How long past the announced start the imminent cadence holds before falling back to the normal
// poll — a late or abandoned premiere must not be hit every 5s for hours (bot-flagging risk).
const IMMINENT_WINDOW_MS = 10 * 60_000
// Consecutive not-live status polls required before declaring the stream over. A single response
// with neither is_live nor is_upcoming can be a transient InnerTube glitch or youtubei.js parse
// drift (the reader's end detection needs two misses for the same reason), and for a fixed-video
// column a premature end is terminal.
const STATUS_END_CONFIRM_POLLS = 2
const STATUS_FAILURE_THRESHOLD = 3
// Consecutive status-poll failures double the next delay up to this cap, so a deleted or
// unreachable video isn't hammered at the waiting-room cadence indefinitely.
const STATUS_BACKOFF_MAX_MS = 60_000
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
/** Longest description kept on a user-card profile; channel descriptions can run to pages. */
const PROFILE_DESCRIPTION_MAX = 300

/**
 * Reads a YouTube channel's (or a specific video's) live chat, wrapped in a
 * lifecycle state machine: offline → waiting room → live → ended, plus replay.
 * Chat is read via {@link LiveChatReader} (raw InnerTube), not youtubei.js's
 * LiveChat class.
 *
 * A monotonic generation token guards the async lifecycle: `connect()`/`disconnect()`
 * bump it and every awaited step re-checks it, so a disconnect (e.g. channel removal)
 * while a `/live` resolve, `getInfo`, or reader poll is in flight can never start or
 * keep a reader behind the UI. The reader InnerTube is acquired lazily inside `connect()` (the
 * authenticated session when logged in — so moderator-only held messages arrive — else anonymous)
 * so creating it never blocks adding the channel.
 */
export class YouTubeSource extends BaseChatSource {
  readonly id: string
  readonly platform: Platform = 'youtube'
  readonly #target: string
  readonly #getReader: () => Promise<Innertube>
  readonly #fetch: typeof fetch
  readonly #emotes: EmoteEngine
  readonly #auth: YouTubeAuthManager
  /** Fixed video ids are terminal once ended; channel/handle targets keep looking for the next stream. */
  readonly #fixedVideo: boolean
  #yt: Innertube | undefined
  #reader: LiveChatReader | undefined
  #signaler: YouTubeSignaler | undefined
  #videoId: string | undefined
  #channelId: string | undefined
  /** Last stream title announced as the label, so a re-poll only re-emits it when it actually changes. */
  #title: string | undefined
  /** Initial chat continuation, kept so send eligibility can be re-probed after a login/identity change. */
  #chatContinuation: string | undefined
  /** `:shortcut:` → emojiId for the chat's proprietary emojis, used to convert typed shortcuts on send. */
  #emojiSendMap = new Map<string, string>()
  #resolveTimer: ReturnType<typeof setTimeout> | undefined
  #statusTimer: ReturnType<typeof setTimeout> | undefined
  #generation = 0
  /** Last stream-state, shown again once any stall clears. */
  #streamStatus: SourceStatus = { state: 'offline' }
  /** Chat reader is failing (set by the reader's onStall, cleared by onResume). */
  #chatStalled = false
  /** Video-status poll is failing. */
  #statusStalled = false
  #statusFailures = 0
  /** Consecutive successful status polls reporting neither live nor upcoming (see {@link STATUS_END_CONFIRM_POLLS}). */
  #statusNotLivePolls = 0
  /** Sequence number for send-restriction probes, so only the latest may apply its result. */
  #probeSeq = 0
  /** Reader reports sustained parse degradation (unrecognized actions); shown on waiting/live. */
  #chatDegraded = false

  constructor(
    target: string,
    getReader: () => Promise<Innertube>,
    fetchFn: typeof fetch,
    emotes: EmoteEngine,
    auth: YouTubeAuthManager
  ) {
    super()
    this.#target = normalizeTarget('youtube', target)
    this.#getReader = getReader
    this.#fetch = fetchFn
    this.#emotes = emotes
    this.#auth = auth
    this.#fixedVideo = VIDEO_ID_RE.test(this.#target)
    this.id = channelId('youtube', target)
  }

  async connect(): Promise<void> {
    const generation = this.#begin()
    this.setStatus({ state: 'connecting' })
    await this.#open(generation)
  }

  async disconnect(): Promise<void> {
    // Bump the generation so any in-flight resolve/getInfo/poll and any scheduled
    // timer from this lifecycle become stale and bail before touching state.
    this.#generation += 1
    this.#stopChat()
    this.#clearTimers()
    // Drop the cached reader instance so the next connect re-acquires it — a reconnect on YouTube
    // login/logout must switch the poll between the authenticated and anonymous sessions.
    this.#yt = undefined
    this.setStatus({ state: 'offline' })
  }

  emoteScope(): { platform: Platform; channelId: string } | undefined {
    return this.#channelId === undefined
      ? undefined
      : { platform: 'youtube', channelId: this.#channelId }
  }

  /** The video this source is currently reading, once resolved — so discovery can avoid re-adding it. */
  resolvedVideoId(): string | undefined {
    return this.#videoId
  }

  // YouTube has no native reply; the renderer tags the user inline, so `replyTo` is unused here.
  async send(text: string, _replyTo?: string): Promise<void> {
    if (this.#videoId === undefined) {
      throw new Error('No live video to send to')
    }
    // #videoId outlives the stream (it's kept for the post-end lifecycle), so gate on the stream
    // state too — a send right after the end must not target the dead chat.
    const state = this.#streamStatus.state
    if (state !== 'live' && state !== 'waiting') {
      throw new Error('The stream has ended — no live chat to send to')
    }
    await this.#auth.sendMessage(this.#videoId, this.#channelId, text, this.#emojiSendMap)
  }

  getMessageActions(menuToken: string): Promise<ChatAction[]> {
    return this.#auth.getMessageActions(menuToken)
  }

  runMessageAction(menuToken: string, actionId: string, timeoutSeconds?: number): Promise<void> {
    return this.#auth.runMessageAction(menuToken, actionId, timeoutSeconds)
  }

  runHeldAction(token: string): Promise<void> {
    return this.#auth.runHeldAction(token)
  }

  /**
   * Fetch a Super Chat's reply thread (the donation followed by its replies) from the engagement
   * panel the `threadToken` identifies, so the whole chain can be shown in one view. Reading is
   * anonymous like the live chat, so it works without login. Emotes are tokenized as in the live feed.
   */
  async getReplyThread(threadToken: string): Promise<ChatMessage[]> {
    const yt = this.#yt
    if (yt === undefined) {
      return []
    }
    const response = await yt.actions.execute('get_panel', {
      panelId: 'PAreply_thread',
      params: threadToken,
      parse: false
    })
    const messages = parseReplyThread(this.id, response.data)
    for (const message of messages) {
      message.fragments = this.#emotes.tokenize(message.fragments, 'youtube', this.#channelId)
    }
    return messages
  }

  /**
   * Best-effort public profile for a chat author — on YouTube the author id *is* the channel id,
   * so this reads the channel page through the anonymous reader. Channel header shapes vary
   * between page generations (C4TabbedHeader vs PageHeader), so every field is read defensively.
   * `createdAt` is omitted: the join date only lives on the About page, whose shape is too
   * volatile to chase. Returns undefined on any failure (the card renders without the extras).
   */
  async getUserProfile(userId: string): Promise<UserProfile | undefined> {
    try {
      const yt = this.#yt ?? (await this.#getReader())
      const channel = await yt.getChannel(userId)
      return profileFromChannel(userId, channel)
    } catch {
      return undefined
    }
  }

  /** Begin a new lifecycle generation; returns its token. */
  #begin(): number {
    this.#generation += 1
    this.#chatStalled = false
    this.#statusStalled = false
    this.#statusFailures = 0
    this.#statusNotLivePolls = 0
    this.#chatDegraded = false
    return this.#generation
  }

  #isStale(generation: number): boolean {
    return generation !== this.#generation
  }

  /** Update the remembered stream state; a successful status update clears a status-poll stall. */
  #setStreamStatus(status: SourceStatus): void {
    this.#streamStatus = status
    this.#statusStalled = false
    this.#refreshStatus()
  }

  /**
   * Reconcile the visible status. A chat-poll or status-poll stall shows as an error;
   * otherwise the remembered stream state. A healthy video-status poll therefore never
   * masks an ongoing chat-poll failure — the chat stall persists until the reader resumes.
   */
  #refreshStatus(): void {
    if (this.#chatStalled) {
      this.setStatus({ state: 'error', message: 'Live chat connection lost — retrying' })
    } else if (this.#statusStalled) {
      this.setStatus({ state: 'error', message: 'Lost connection to YouTube — retrying' })
    } else {
      this.setStatus(this.#withDegraded(this.#streamStatus))
    }
  }

  /**
   * Stamp `degraded: true` onto a waiting/live stream status while the reader reports sustained
   * parse degradation; the key is omitted entirely otherwise (exactOptionalPropertyTypes).
   */
  #withDegraded(status: SourceStatus): SourceStatus {
    if (this.#chatDegraded && (status.state === 'waiting' || status.state === 'live')) {
      return { ...status, degraded: true }
    }
    return status
  }

  async #open(generation: number): Promise<void> {
    if (this.#isStale(generation)) {
      return
    }
    let yt = this.#yt
    if (yt === undefined) {
      // Acquiring the reader can fail (e.g. an offline launch) — every #open retries it, so the
      // re-resolve chain keeps running until YouTube is reachable instead of dying silently.
      try {
        yt = await this.#getReader()
      } catch {
        if (this.#isStale(generation)) {
          return
        }
        this.setStatus({ state: 'error', message: 'Could not reach YouTube' })
        this.#scheduleResolve(generation)
        return
      }
      if (this.#isStale(generation)) {
        return
      }
      this.#yt = yt
    }
    const videoId = await this.#resolveVideoId()
    if (this.#isStale(generation)) {
      return
    }
    if (videoId === undefined) {
      this.#setStreamStatus({ state: 'offline' })
      this.#scheduleResolve(generation)
      return
    }
    const videoChanged = this.#videoId !== videoId
    this.#videoId = videoId
    // Tell the manager which video this column now follows (first resolve or a roll to the next
    // stream), so a standalone column for the same video can be removed to avoid a duplicate chat.
    if (videoChanged) {
      this.emitResolved(videoId)
    }
    let info: YT.VideoInfo
    try {
      info = await yt.getInfo(videoId)
    } catch {
      if (this.#isStale(generation)) {
        return
      }
      this.#setStreamStatus({ state: 'offline' })
      this.#scheduleResolve(generation)
      return
    }
    if (this.#isStale(generation)) {
      return
    }
    this.#applyInfo(info, generation)
  }

  #applyInfo(info: YT.VideoInfo, generation: number): void {
    if (this.#isStale(generation)) {
      return
    }
    const basic = info.basic_info
    this.#updateTitle(basic.title)
    this.#channelId = basic.channel_id ?? undefined
    if (this.#channelId !== undefined) {
      this.#emotes.ensureChannel('youtube', this.#channelId)
    }

    if (basic.is_live === true) {
      this.#setStreamStatus({ state: 'live' })
    } else if (basic.is_upcoming === true) {
      const start = basic.start_timestamp
      this.#setStreamStatus(
        start ? { state: 'waiting', scheduledStart: start.getTime() } : { state: 'waiting' }
      )
    } else if (basic.is_post_live_dvr === true || basic.is_live_content === true) {
      if (!this.#fixedVideo) {
        // A channel/handle target must never latch onto the just-ended stream's replay: report
        // the end and keep re-resolving so the channel's next live stream is picked up.
        this.#chatStalled = false
        this.#setStreamStatus({ state: 'ended' })
        this.#scheduleResolve(generation, ENDED_POLL_MS)
        return
      }
      this.#setStreamStatus({ state: 'replay' })
    } else {
      this.#setStreamStatus({ state: 'offline' })
      this.#scheduleResolve(generation)
      return
    }

    if (info.livechat) {
      // A replay's chat can't be posted to, so only live/upcoming chats carry a send restriction.
      this.#chatContinuation = info.livechat.is_replay ? undefined : info.livechat.continuation
      this.#startChat(info.livechat.continuation, info.livechat.is_replay, generation)
      if (this.#chatContinuation !== undefined) {
        void this.#probeSendRestriction(generation)
        void this.#loadEmojis(generation)
      }
      if (basic.is_live === true || basic.is_upcoming === true) {
        this.#scheduleStatus(generation)
      }
    } else {
      // Live/upcoming but chat isn't open yet — retry shortly.
      this.#scheduleResolve(generation)
    }
  }

  /** Announce the current stream's title as the column label, but only when it's known and changed. */
  #updateTitle(title: string | null | undefined): void {
    if (typeof title !== 'string' || title === '' || title === this.#title) {
      return
    }
    this.#title = title
    this.emitTitle(title)
  }

  /**
   * Probe whether the signed-in user can chat here (e.g. subscribers-only / members-only) and
   * reflect it so the renderer can switch the composer to read-only with the reason. Read is
   * anonymous, so this needs the authenticated session; it's a no-op when logged out.
   */
  async #probeSendRestriction(generation: number): Promise<void> {
    const continuation = this.#chatContinuation
    if (continuation === undefined) {
      return
    }
    // Identity switches never bump the generation, so overlapping probes (e.g. a slow probe for
    // the old identity racing the refresh for the new one) are sequenced: only the most recently
    // started probe may apply its result, whichever order they resolve in.
    const seq = ++this.#probeSeq
    const reason = await this.#auth.checkSendRestriction(continuation)
    if (this.#isStale(generation) || seq !== this.#probeSeq) {
      return
    }
    this.setSendRestriction(reason)
  }

  /**
   * Load the chat's proprietary emoji catalog (as the signed-in user) into the emote picker and the
   * send map, so YouTube emojis can be picked/typed and are sent as image emojis. A no-op when
   * logged out — the picker just won't list them. Best-effort.
   */
  async #loadEmojis(generation: number): Promise<void> {
    const continuation = this.#chatContinuation
    if (continuation === undefined) {
      return
    }
    const emojis = await this.#auth.getEmojiCatalog(continuation)
    if (this.#isStale(generation) || emojis.length === 0 || this.#channelId === undefined) {
      return
    }
    this.#emojiSendMap = emojiSendMap(emojis)
    this.#emotes.setYouTubeEmojis(this.#channelId, toResolvedEmotes(emojis))
  }

  refreshSendability(): void {
    void this.#probeSendRestriction(this.#generation)
    // The emoji catalog is also identity-bound (empty when logged out), so a chat connected
    // before login needs it re-fetched now, not only on the next stream lifecycle.
    void this.#loadEmojis(this.#generation)
  }

  #startChat(continuation: string, isReplay: boolean, generation: number): void {
    const yt = this.#yt
    if (yt === undefined || this.#reader !== undefined || this.#isStale(generation)) {
      return
    }
    // A stall belongs to the reader that reported it; a fresh reader (e.g. after a re-bootstrap)
    // starts healthy.
    if (this.#chatStalled) {
      this.#chatStalled = false
      this.#refreshStatus()
    }
    const reader = new LiveChatReader(yt.actions, this.id, continuation, isReplay, {
      onMessages: (messages) => {
        if (this.#isStale(generation)) {
          return
        }
        for (const message of messages) {
          message.fragments = this.#emotes.tokenize(message.fragments, 'youtube', this.#channelId)
          this.emitMessage(message)
        }
      },
      onReplacements: (replacements) => {
        if (this.#isStale(generation)) {
          return
        }
        for (const message of replacements) {
          message.fragments = this.#emotes.tokenize(message.fragments, 'youtube', this.#channelId)
          this.emitReplace(message)
        }
      },
      onClears: (clears) => {
        if (this.#isStale(generation)) {
          return
        }
        for (const clear of clears) {
          this.emitClear(clear)
        }
      },
      onEnd: () => {
        this.#onEnded(generation)
      },
      onStall: () => {
        if (!this.#isStale(generation)) {
          this.#chatStalled = true
          this.#refreshStatus()
        }
      },
      onResume: () => {
        if (!this.#isStale(generation)) {
          this.#chatStalled = false
          this.#refreshStatus()
        }
      },
      onAuthError: () => {
        // The authed read session's rotating cookie aged out: recover it (rotate/rebuild) and
        // reconnect so this reader re-binds to the rebuilt instance. Debounced inside the manager.
        if (!this.#isStale(generation)) {
          void this.#auth.recoverReads()
        }
      },
      onDegraded: (degraded) => {
        if (!this.#isStale(generation)) {
          this.#chatDegraded = degraded
          this.#refreshStatus()
        }
      },
      onBroken: () => {
        if (!this.#isStale(generation)) {
          void this.#rebootstrap()
        }
      }
    })
    this.#reader = reader
    void this.#startReader(reader, continuation, isReplay, generation)
    if (!isReplay && this.#videoId !== undefined) {
      this.#startSignaler(this.#videoId, generation)
    }
  }

  /**
   * Start the reader, seeding it with the `live_chat` page snapshot when signed in: that page
   * carries the standing automod "held for review" queue the `get_live_chat` POST API omits (see
   * {@link YouTubeAuthManager.fetchLiveChatBootstrap}). Best-effort — a logged-out session or any
   * fetch/parse failure yields undefined, and the reader just polls the API as before. Replays have
   * no held queue, so they skip the fetch.
   */
  async #startReader(
    reader: LiveChatReader,
    continuation: string,
    isReplay: boolean,
    generation: number
  ): Promise<void> {
    let initial: unknown
    try {
      initial = isReplay
        ? undefined
        : await this.#auth.fetchLiveChatBootstrap(continuation, this.#videoId)
    } catch {
      // The page snapshot is a best-effort enhancement; never let it block ordinary polling.
      initial = undefined
    }
    // A disconnect/roll (or a replaced reader) while the page fetch was in flight must not start a
    // reader behind the current lifecycle.
    if (this.#isStale(generation) || this.#reader !== reader) {
      return
    }
    reader.start(initial)
  }

  /**
   * Attach the push signaler (behind the flag): its nudges drive immediate fetches and relax the
   * reader's timer to a backstop. Best-effort — on any failure the reader keeps polling, so chat is
   * never blocked on the signaler.
   */
  #startSignaler(videoId: string, generation: number): void {
    if (this.#signaler !== undefined || this.#isStale(generation)) {
      return
    }
    // Only relax the reader to signal-driven once a *real* invalidation arrives — never on connect
    // or handshake (CUB-1), so a silent subscription can't slow chat below adaptive polling.
    let gotRealSignal = false
    const signaler = new YouTubeSignaler(
      this.#fetch,
      videoId,
      {
        onSignal: (publishUsec) => {
          if (this.#isStale(generation)) {
            return
          }
          this.#reader?.nudge(publishUsec)
          if (!gotRealSignal) {
            gotRealSignal = true
            this.#log('first real invalidation — reader now signal-driven')
            this.#reader?.setSignalDriven(true)
          }
        },
        onDisconnect: () => {
          if (this.#isStale(generation)) {
            return
          }
          gotRealSignal = false
          this.#reader?.setSignalDriven(false)
        }
      },
      (message) => {
        this.#log(message)
      }
    )
    this.#signaler = signaler
    signaler.start()
  }

  #log(message: string): void {
    if (!SIGNALER_DEBUG) {
      return
    }
    const time = new Date().toISOString().slice(11, 23)
    process.stdout.write(`[${time}] [yt-signaler] ${this.id}: ${message}\n`)
  }

  async #resolveVideoId(): Promise<string | undefined> {
    if (this.#fixedVideo) {
      return this.#target
    }
    // Resolve the channel's current live video by loading its `/live` page through
    // the pinned browser identity and reading the canonical watch id. (InnerTube's
    // resolve_url endpoint 400s on the `/live` redirect.)
    const url = liveUrl(this.#target)
    if (url === undefined) {
      return undefined
    }
    try {
      const response = await this.#fetch(url)
      if (!response.ok) {
        return undefined
      }
      const fromUrl = response.url.match(/[?&]v=([A-Za-z0-9_-]{11})/)
      if (fromUrl !== null && fromUrl[1] !== undefined) {
        return fromUrl[1]
      }
      const html = await response.text()
      const canonical = html.match(
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})">/
      )
      if (canonical !== null && canonical[1] !== undefined) {
        return canonical[1]
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * The reader declared its continuation unusable (sustained poll failures): tear the chat down
   * and re-run the open sequence so getInfo provides a fresh continuation. The stalled error
   * stays visible until a new reader starts (or the stream turns out to be over).
   */
  async #rebootstrap(): Promise<void> {
    // Adopt a fresh generation: the torn-down reader's and signaler's late callbacks (a chunk
    // already read before stop, the deferred onDisconnect from an aborted long-poll) must go
    // stale instead of cross-wiring the replacement reader's polling mode.
    const generation = this.#begin()
    this.#stopChat()
    this.#clearTimers()
    // Drop the cached instance so #open re-acquires the current authed reader: a write- or read-path
    // auth recovery may have rebuilt it, and reusing the superseded instance would keep the reader
    // bound to the old session.
    this.#yt = undefined
    await this.#open(generation)
  }

  #onEnded(generation: number): void {
    if (this.#isStale(generation) || this.currentStatus.state === 'ended') {
      return
    }
    const wasWaiting = this.#streamStatus.state === 'waiting'
    // Adopt a fresh generation: an in-flight status poll or reader callback from the lifecycle
    // that just ended must go stale rather than resurrect 'live' after this teardown.
    const endedGeneration = this.#begin()
    this.#stopChat()
    this.#clearTimers()
    this.#streamStatus = { state: 'ended' }
    this.#refreshStatus()
    if (!this.#fixedVideo || wasWaiting) {
      // A channel/handle target may go live again — keep looking at a low frequency. And a fixed
      // video whose *waiting-room* chat closed isn't over: YouTube/streamers recreate the chat
      // around going live, so re-open instead of being terminal before the stream ever started.
      this.#scheduleResolve(endedGeneration, ENDED_POLL_MS)
    }
  }

  #scheduleResolve(generation: number, delay: number = OFFLINE_POLL_MS): void {
    if (
      this.#isStale(generation) ||
      this.#resolveTimer !== undefined ||
      this.#reader !== undefined
    ) {
      return
    }
    this.#resolveTimer = setTimeout(() => {
      this.#resolveTimer = undefined
      void this.#open(generation)
    }, delay)
  }

  #scheduleStatus(generation: number): void {
    if (this.#isStale(generation) || this.#statusTimer !== undefined) {
      return
    }
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = undefined
      void this.#pollStatus(generation)
    }, this.#nextStatusDelay())
  }

  /**
   * Delay until the next status poll. While waiting for an announced start, the poll
   * converges onto the scheduled go-live time and then checks every few seconds until the
   * stream is actually live — so the column flips from WAITING to LIVE right at the
   * announced time (or as soon as a late stream starts), not up to one full poll late.
   * Consecutive failures double the delay (capped at {@link STATUS_BACKOFF_MAX_MS}), so the
   * fast cadences only apply while polls are succeeding.
   */
  #nextStatusDelay(): number {
    const status = this.#streamStatus
    let delay = STATUS_POLL_MS
    if (status.state === 'waiting' && status.scheduledStart !== undefined) {
      const untilStart = status.scheduledStart - Date.now()
      if (untilStart > 0) {
        delay = Math.min(STATUS_POLL_MS, Math.max(1000, untilStart))
      } else if (-untilStart <= IMMINENT_WINDOW_MS) {
        // Past the announced start: fast polls, but only within the grace window — a stream
        // that's an hour late (or an abandoned premiere) falls back to the normal cadence.
        delay = IMMINENT_POLL_MS
      }
    }
    if (this.#statusFailures > 0) {
      return Math.min(STATUS_BACKOFF_MAX_MS, delay * 2 ** this.#statusFailures)
    }
    return delay
  }

  async #pollStatus(generation: number): Promise<void> {
    if (this.#isStale(generation) || this.#videoId === undefined || this.#yt === undefined) {
      return
    }
    try {
      const basic = (await this.#yt.getBasicInfo(this.#videoId)).basic_info
      if (this.#isStale(generation)) {
        return
      }
      this.#statusFailures = 0
      this.#updateTitle(basic.title)
      if (basic.is_live === true) {
        this.#statusNotLivePolls = 0
        this.#setStreamStatus({ state: 'live' })
      } else if (basic.is_upcoming === true) {
        this.#statusNotLivePolls = 0
        const start = basic.start_timestamp
        this.#setStreamStatus(
          start ? { state: 'waiting', scheduledStart: start.getTime() } : { state: 'waiting' }
        )
      } else {
        // Never end on a single not-live response (see STATUS_END_CONFIRM_POLLS) — re-poll and
        // only declare the end once consecutive polls agree.
        this.#statusNotLivePolls += 1
        if (this.#statusNotLivePolls >= STATUS_END_CONFIRM_POLLS) {
          this.#onEnded(generation)
          return
        }
      }
    } catch {
      if (this.#isStale(generation)) {
        return
      }
      this.#statusFailures += 1
      if (this.#statusFailures >= STATUS_FAILURE_THRESHOLD) {
        this.#statusStalled = true
        this.#refreshStatus()
      }
    }
    this.#scheduleStatus(generation)
  }

  #stopChat(): void {
    if (this.#signaler !== undefined) {
      this.#signaler.stop()
      this.#signaler = undefined
    }
    if (this.#reader !== undefined) {
      this.#reader.stop()
      this.#reader = undefined
    }
    // The degraded flag belongs to the reader that set it — meaningless once it stops.
    this.#chatDegraded = false
    this.#chatContinuation = undefined
    this.#emojiSendMap = new Map()
    this.setSendRestriction(undefined)
  }

  #clearTimers(): void {
    if (this.#resolveTimer !== undefined) {
      clearTimeout(this.#resolveTimer)
      this.#resolveTimer = undefined
    }
    if (this.#statusTimer !== undefined) {
      clearTimeout(this.#statusTimer)
      this.#statusTimer = undefined
    }
  }
}

/** Map a fetched channel page onto the user card's profile; undefined when even a title is missing. */
function profileFromChannel(userId: string, channel: unknown): UserProfile | undefined {
  if (!isObject(channel)) {
    return undefined
  }
  const metadata = isObject(channel['metadata']) ? channel['metadata'] : {}
  const header = readHeader(channel['header'])
  const displayName = nonEmpty(textOf(metadata['title'])) ?? nonEmpty(header.title)
  if (displayName === undefined) {
    return undefined
  }
  const handle = header.handle ?? handleFromUrl(metadata['vanity_channel_url'])
  const avatarUrl = largestThumbnailUrl([...thumbnailList(metadata['avatar']), ...header.avatars])
  const audience = nonEmpty(header.audience)
  const description = truncateDescription(nonEmpty(textOf(metadata['description'])))
  return {
    platform: 'youtube',
    userId,
    displayName,
    url: `https://www.youtube.com/channel/${userId}`,
    ...(handle !== undefined && { handle }),
    ...(avatarUrl !== undefined && { avatarUrl }),
    ...(audience !== undefined && { audience }),
    ...(description !== undefined && { description })
  }
}

interface ChannelHeaderFields {
  title: string | undefined
  handle: string | undefined
  audience: string | undefined
  avatars: readonly unknown[]
}

/** Channel-header fields, merged across whichever header generations the page carries. */
function readHeader(header: unknown): ChannelHeaderFields {
  const node = isObject(header) ? header : {}
  const c4 = readC4Header(node)
  const page = readPageHeader(isObject(node['content']) ? node['content'] : undefined)
  return {
    title: c4.title ?? page.title,
    handle: c4.handle ?? page.handle,
    audience: c4.audience ?? page.audience,
    avatars: [...c4.avatars, ...page.avatars]
  }
}

/** The classic C4TabbedHeader: author, subscriber count, and handle live directly on the node. */
function readC4Header(header: Record<string, unknown>): ChannelHeaderFields {
  const author = isObject(header['author']) ? header['author'] : {}
  return {
    title: typeof author['name'] === 'string' ? author['name'] : undefined,
    handle: textOf(header['channel_handle']),
    audience: textOf(header['subscribers']),
    avatars: thumbnailList(author['thumbnails'])
  }
}

/** The newer PageHeader's content view: the "@handle" and "1.23M subscribers" strings sit in its metadata rows. */
function readPageHeader(content: Record<string, unknown> | undefined): ChannelHeaderFields {
  if (content === undefined) {
    return { title: undefined, handle: undefined, audience: undefined, avatars: [] }
  }
  const texts = metadataRowTexts(content['metadata'])
  const image = isObject(content['image']) ? content['image'] : {}
  return {
    title: isObject(content['title']) ? textOf(content['title']['text']) : undefined,
    handle: texts.find((text) => text.startsWith('@')),
    audience: texts.find((text) => /subscriber/i.test(text)),
    // A DecoratedAvatarView nests an AvatarView; a ContentPreviewImageView carries the list directly.
    avatars: thumbnailList(isObject(image['avatar']) ? image['avatar']['image'] : image['image'])
  }
}

/** All metadata-row strings from a PageHeader content view ("@handle", "1.23M subscribers", …). */
function metadataRowTexts(metadata: unknown): string[] {
  const rows = isObject(metadata) ? metadata['metadata_rows'] : undefined
  if (!Array.isArray(rows)) {
    return []
  }
  const texts: string[] = []
  for (const row of rows) {
    const parts = isObject(row) ? row['metadata_parts'] : undefined
    if (!Array.isArray(parts)) {
      continue
    }
    for (const part of parts) {
      const text = isObject(part) ? nonEmpty(textOf(part['text'])) : undefined
      if (text !== undefined) {
        texts.push(text)
      }
    }
  }
  return texts
}

/** The largest thumbnail's URL among youtubei.js `Thumbnail` entries, read defensively. */
function largestThumbnailUrl(thumbnails: readonly unknown[]): string | undefined {
  let url: string | undefined
  let largest = -1
  for (const thumbnail of thumbnails) {
    if (!isObject(thumbnail) || typeof thumbnail['url'] !== 'string') {
      continue
    }
    const width = typeof thumbnail['width'] === 'number' ? thumbnail['width'] : 0
    if (width > largest) {
      largest = width
      url = thumbnail['url']
    }
  }
  return url
}

function thumbnailList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** The plain string of a youtubei.js `Text` node (or a raw string). */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (isObject(value) && typeof value['text'] === 'string') {
    return value['text']
  }
  return undefined
}

/** The `@handle` segment of a vanity channel URL (e.g. `http://www.youtube.com/@LofiGirl`). */
function handleFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') {
    return undefined
  }
  return url.match(/\/(@[^/?#]+)/)?.[1]
}

/** Collapse empty strings to undefined: youtubei.js `Text` nodes can parse to `''`. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
}

/** Cap a channel description for the card; the page exposes the full multi-paragraph text. */
function truncateDescription(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= PROFILE_DESCRIPTION_MAX) {
    return text
  }
  return `${text.slice(0, PROFILE_DESCRIPTION_MAX - 1).trimEnd()}…`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
