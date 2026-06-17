import { randomUUID } from 'node:crypto'
import { Innertube, YTNodes } from 'youtubei.js'
import type { AuthStore } from '@main/auth/AuthStore'
import type { ChatAction, YouTubeChannel } from '@shared/model'
import { proxiedFetch, proxyUrl } from '@main/net/proxy'
import { isYouTubeCookieHost } from '@main/sources/channelId'
import { isAuthError, NotLoggedInError } from '@main/sources/youtube/authError'
import {
  decodeHeldToken,
  deepModerationParams,
  findActionEndpoint,
  moderationParams,
  parseMenuActions,
  resolveConfirmDialog,
  timeoutParams
} from '@main/sources/youtube/liveChatActions'
import {
  buildTextSegments,
  classifySendResponse,
  encodeSendParams
} from '@main/sources/youtube/liveChatSend'
import { collectEmojis, type YouTubeEmoji } from '@main/sources/youtube/youtubeEmoji'

// Break the send path into its stages (getInfo fallback vs the send_message request) on stdout, to
// locate where send latency comes from. Enable with `POGCHATTER_SEND_DEBUG=1`.
const SEND_DEBUG = process.env['POGCHATTER_SEND_DEBUG'] === '1'

const STORE_KEY = 'youtube'
// Bound the best-effort live_chat HTML bootstrap so a black-hole connection (no RST/FIN) can't
// hang forever on the critical path that gates the reader's first poll. Matches httpJson's TIMEOUT_MS.
const BOOTSTRAP_TIMEOUT_MS = 6000
// `#rotateCookies` is single-use and invalidates the browser's token copy, so a flurry of read
// 401s must rotate at most once per window — the reader keeps backing off in between.
const READ_RECOVERY_DEBOUNCE_MS = 60_000
const ROTATE_PAGE_URL =
  'https://accounts.youtube.com/RotateCookiesPage?origin=https://www.youtube.com&yt_pid=1'
const ROTATE_URL = 'https://accounts.youtube.com/RotateCookies'
/** Sentinel id for the cookie's own identity (no `on_behalf_of_user` delegation). */
const DEFAULT_CHANNEL = 'default'

interface StoredYouTube {
  cookie: string
  /** Selected channel id (`YouTubeChannel.id`); absent means the default identity. */
  channelId?: string
}

/** The account switcher hands out per-channel identity tokens; we only need the page id. */
interface SupportedToken {
  pageIdToken?: { pageId?: string }
  datasyncIdToken?: { datasyncIdToken?: string }
}

/**
 * The `X-Goog-PageId` (page id / delegated session id) used to act as a brand channel.
 * The selected identity needs no delegation, so only non-selected channels carry one.
 */
function extractPageId(item: { endpoint?: { payload?: unknown } }): string | undefined {
  const payload = item.endpoint?.payload as { supportedTokens?: unknown } | undefined
  const tokens = payload?.supportedTokens
  if (!Array.isArray(tokens)) {
    return undefined
  }
  for (const token of tokens as SupportedToken[]) {
    const pageId = token.pageIdToken?.pageId
    if (typeof pageId === 'string' && pageId !== '') {
      return pageId
    }
    const datasync = token.datasyncIdToken?.datasyncIdToken
    if (typeof datasync === 'string' && datasync.includes('||')) {
      const head = datasync.split('||')[0]
      if (head !== undefined && head !== '') {
        return head
      }
    }
  }
  return undefined
}

function largestThumbnailUrl(photos: Array<{ url: string; width?: number }>): string | undefined {
  let best: { url: string; width?: number } | undefined
  for (const photo of photos) {
    if (best === undefined || (photo.width ?? 0) > (best.width ?? 0)) {
      best = photo
    }
  }
  return best?.url
}

type RawText = { simpleText?: string; runs?: Array<{ text?: string }> }
interface RawChatRestriction {
  continuationContents?: {
    liveChatContinuation?: {
      // The action panel holds the message input when you can chat, or a restricted-participation
      // notice (with its reason) when you can't (e.g. subscribers-only / members-only chat).
      actionPanel?: {
        liveChatMessageInputRenderer?: unknown
        liveChatRestrictedParticipationRenderer?: { message?: RawText }
      }
    }
  }
}

function plainText(text: RawText | undefined): string | undefined {
  if (text === undefined) {
    return undefined
  }
  if (typeof text.simpleText === 'string' && text.simpleText !== '') {
    return text.simpleText
  }
  const joined = (text.runs ?? [])
    .map((run) => run.text ?? '')
    .join('')
    .trim()
  return joined === '' ? undefined : joined
}

/** Read a chat-send restriction reason from a raw `get_live_chat` response, or undefined if allowed. */
function restrictionReason(response: RawChatRestriction): string | undefined {
  const panel = response.continuationContents?.liveChatContinuation?.actionPanel
  if (panel?.liveChatRestrictedParticipationRenderer === undefined) {
    return undefined
  }
  return plainText(panel.liveChatRestrictedParticipationRenderer.message) ?? 'Chat is restricted'
}

/**
 * Extract the `ytInitialData` JSON object embedded in a `live_chat` HTML page. String-aware brace
 * matching (so a `{`/`}` inside a chat message can't unbalance the scan); returns undefined if the
 * marker is absent or the slice doesn't parse.
 */
export function extractYtInitialData(html: string): unknown | undefined {
  // YouTube assigns it as `window["ytInitialData"] = {…}` (sometimes `var ytInitialData = {…}`), so
  // anchor on the name and take the next object brace rather than a fixed `name = {` shape.
  const marker = html.indexOf('ytInitialData')
  if (marker < 0) {
    return undefined
  }
  const start = html.indexOf('{', marker)
  if (start < 0) {
    return undefined
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Parse a pasted `Cookie` header / `name=value` blob into a fresh jar. */
function parseJar(raw: string): Map<string, string> {
  const jar = new Map<string, string>()
  // Tolerate a pasted `Cookie:` header prefix (copied along with the header name) — without this the
  // first pair becomes a bogus `Cookie: <name>` entry and the real first cookie (e.g. YSC) is lost,
  // so YSC goes out corrupted.
  const cleaned = raw.replace(/^\s*cookie:\s*/i, '')
  for (const part of cleaned.split(/[;\n]/)) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const name = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (name !== '' && value !== '') {
        jar.set(name, value)
      }
    }
  }
  return jar
}

function jarString(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** The URL string of a fetch input (string, URL, or Request). */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

/** The rich-message segments + client id from a send_message request body, for SEND_DEBUG tracing. */
function sendBodySummary(body: unknown): string {
  if (typeof body !== 'string') {
    return `(non-string body: ${typeof body})`
  }
  try {
    const parsed = JSON.parse(body) as {
      richMessage?: { textSegments?: unknown }
      clientMessageId?: unknown
    }
    return JSON.stringify({
      textSegments: parsed.richMessage?.textSegments ?? null,
      clientMessageId: parsed.clientMessageId ?? null
    })
  } catch {
    return '(unparseable body)'
  }
}

/**
 * Whether a fetch input is eligible to carry the pasted session cookies: an HTTPS request to a
 * `youtube.com` (sub)domain — the only hosts a browser would send those cookies to. The HTTPS
 * requirement stops a downgrade carrying the jar over cleartext; the `youtube.com`-only host scope
 * (not `youtu.be`/`youtube-nocookie.com`) keeps the broad Google jar off domains the browser never
 * sends it to and that must not write back into it.
 */
function isYouTubeRequest(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const url = new URL(requestUrl(input))
    return url.protocol === 'https:' && isYouTubeCookieHost(url.hostname)
  } catch {
    return false
  }
}

/** A Set-Cookie revokes the cookie if it has a non-positive Max-Age or an Expires in the past. */
function isDeletion(attrs: string): boolean {
  const maxAge = /max-age=(-?\d+)/.exec(attrs)
  if (maxAge !== null) {
    return Number(maxAge[1]) <= 0
  }
  const expires = /expires=([^;]+)/.exec(attrs)
  if (expires?.[1] !== undefined) {
    const when = Date.parse(expires[1])
    return Number.isFinite(when)
      ? when <= Date.now()
      : expires[1].includes('1970') || expires[1].includes('1969')
  }
  return false
}

/** Merge `Set-Cookie` headers into a jar. Returns the names of cookies that changed. */
function applySetCookies(jar: Map<string, string>, setCookies: string[]): string[] {
  const changed: string[] = []
  for (const raw of setCookies) {
    const semi = raw.indexOf(';')
    const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim()
    const attrs = semi === -1 ? '' : raw.slice(semi + 1).toLowerCase()
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === '') {
      continue
    }
    if (isDeletion(attrs)) {
      if (jar.delete(name)) {
        changed.push(name)
      }
    } else if (jar.get(name) !== value) {
      jar.set(name, value)
      changed.push(name)
    }
  }
  return changed
}

/**
 * Holds the YouTube login from pasted browser cookies (Google blocks embedded /
 * automated sign-in). Keeps a live cookie jar that captures `Set-Cookie` rotation
 * from every authenticated request (mirroring how a browser stays signed in) and
 * persists it; a stale rotating token is refreshed on demand at restore and on a
 * rejected send (see {@link sendMessage}), not on a timer. Provides an authenticated
 * InnerTube used for sending and (when logged in) reading; reading authenticated is
 * what surfaces moderator-only content. `onChange` fires on login/logout/recovery.
 *
 * Cookie updates are transactional: a new session is built and validated against a
 * temporary jar, and the live jar/instance are swapped in only on success, so a bad
 * "Update" can never corrupt a working session.
 */
export class YouTubeAuthManager {
  readonly #store: AuthStore
  readonly #userAgent: string
  readonly #getVisitorData: () => string | undefined
  readonly #onChange: () => void
  readonly #debug: boolean
  #jar = new Map<string, string>()
  #authed: Innertube | undefined
  /** Channels the account can post as (empty until enumerated; default identity first). */
  #channels: YouTubeChannel[] = []
  /** Selected `YouTubeChannel.id` — `default` until a brand channel is chosen. */
  #selectedId = DEFAULT_CHANNEL
  /**
   * Bumped by every user-initiated auth change (setCookies / selectChannel / logout). The slow,
   * networked startup restore snapshots it: if it moved while the restore was in flight, the
   * restore's completion — installing the session or discarding the stored cookies on an auth
   * failure — must become a no-op rather than clobber the user's fresh state.
   */
  #epoch = 0
  /** Last read-recovery time (epoch ms), so repeated read 401s debounce the single-use rotation. */
  #lastReadRecovery = 0
  /**
   * A read recovery rebuilt `#authed` without reconnecting open readers (the bootstrap path, which
   * runs inside a connect). The next reconnect-requesting recovery fires `#onChange` even if its
   * rotation is debounced, so the open reader rebinds to the rebuilt instance without waiting out the
   * debounce/backoff window.
   */
  #reconnectPending = false

  constructor(
    store: AuthStore,
    userAgent: string,
    getVisitorData: () => string | undefined,
    onChange: () => void,
    debug = false
  ) {
    this.#store = store
    this.#userAgent = userAgent
    this.#getVisitorData = getVisitorData
    this.#onChange = onChange
    this.#debug = debug
  }

  /** Diagnostic logging for the cookie-renewal/auth lifecycle (development only). */
  #log(message: string): void {
    if (this.#debug) {
      console.log(`[youtube-auth] ${message}`)
    }
  }

  get isLoggedIn(): boolean {
    return this.#authed !== undefined
  }

  /**
   * The authenticated InnerTube to read live chat with when logged in, or undefined when logged
   * out (callers fall back to the anonymous reader). Reading authenticated is what surfaces the
   * moderator-only renderers — automod "held for review" messages — that an anonymous poll never
   * receives. Always read the *current* instance per use: it's rebuilt on cookie rotation/recovery.
   */
  readerInnertube(): Innertube | undefined {
    return this.#authed
  }

  /** The account's channels (default identity plus any brand channels). Empty when logged out. */
  getChannels(): YouTubeChannel[] {
    return this.#channels
  }

  /** The selected `YouTubeChannel.id`, or undefined when logged out. */
  getSelectedId(): string | undefined {
    return this.#authed === undefined ? undefined : this.#selectedId
  }

  async init(): Promise<void> {
    const stored = this.#store.get<StoredYouTube>(STORE_KEY)
    if (stored?.cookie === undefined || stored.cookie === '') {
      return
    }
    const epoch = this.#epoch
    const jar = parseJar(stored.cookie)
    this.#jar = jar
    try {
      await this.#restore(jar, stored.channelId, epoch)
    } catch (error) {
      if (this.#epoch !== epoch) {
        // The user logged in/out while the restore was failing — its cleanup is stale: deleting
        // the store now would wipe the cookies the fresh login just persisted.
        return
      }
      // Discard the credentials when the session genuinely failed auth (a 401/403 on dead cookies)
      // or built but isn't logged in (incomplete/expired identity cookies) — neither can ever
      // restore, so keeping them would fail every launch and leave the user silently anonymous. A
      // transient failure (offline launch, 5xx) keeps the stored cookies so a later launch can retry.
      if (isAuthError(error) || error instanceof NotLoggedInError) {
        this.#jar = new Map()
        this.#store.delete(STORE_KEY)
      }
    }
  }

  /**
   * Bring a restored session online. Validate the stored cookies as-is first; only if they fail
   * auth (the browser rotated `__Secure-1PSIDTS` out from under us while the app was closed) do
   * we rotate once and retry. Rotating is single-use and invalidates the browser's copy of the
   * token, so we never do it unless the session is actually stale. `epoch` is init's snapshot —
   * a user auth change during the restore makes every later step a no-op.
   */
  async #restore(
    jar: Map<string, string>,
    channelId: string | undefined,
    epoch: number
  ): Promise<void> {
    try {
      await this.#activate(jar, channelId, epoch)
    } catch (error) {
      if (!isAuthError(error) || this.#epoch !== epoch) {
        throw error
      }
      this.#log('restored session failed auth — rotating cookies once and retrying')
      await this.#rotateCookies()
      await this.#activate(jar, channelId, epoch)
    }
  }

  /** Authenticate from pasted browser cookies. Throws (leaving any existing session intact) if they don't produce a logged-in session. */
  async setCookies(rawCookies: string): Promise<void> {
    const jar = parseJar(rawCookies)
    if (jar.size === 0) {
      throw new Error('No cookies found — paste the youtube.com Cookie header')
    }
    // Build and validate everything against the candidate jar before touching live state.
    await this.#activate(jar, this.#store.get<StoredYouTube>(STORE_KEY)?.channelId)
    this.#epoch += 1
    this.#persist()
    this.#onChange()
  }

  /** Switch which channel sends go out as. Throws if the channel isn't one of the account's. */
  async selectChannel(channelId: string): Promise<void> {
    if (this.#authed === undefined) {
      throw new Error('Log in to YouTube first')
    }
    if (channelId === this.#selectedId) {
      return
    }
    if (!this.#channels.some((channel) => channel.id === channelId)) {
      throw new Error('That channel is not available on this account')
    }
    const onBehalfOfUser = channelId === DEFAULT_CHANNEL ? undefined : channelId
    // Validate the delegated session before swapping it in, so a failed switch leaves sending intact.
    const authed = await this.#createAuthed(this.#jar, onBehalfOfUser)
    this.#authed = authed
    this.#selectedId = channelId
    this.#epoch += 1
    this.#persist()
    this.#onChange()
  }

  logout(): void {
    this.#authed = undefined
    this.#channels = []
    this.#selectedId = DEFAULT_CHANNEL
    this.#jar = new Map()
    this.#epoch += 1
    this.#store.delete(STORE_KEY)
    this.#onChange()
  }

  /**
   * Build the live session from `jar`: enumerate the account's channels from the
   * (non-delegated) base instance, then bind the active instance to the previously
   * selected channel via `on_behalf_of_user`. Mutates live state only after every
   * network step succeeds — and, when restoring (`epoch` given), only if no user
   * auth change landed while those steps were in flight.
   */
  async #activate(
    jar: Map<string, string>,
    storedChannelId: string | undefined,
    epoch?: number
  ): Promise<void> {
    const base = await this.#createAuthed(jar)
    const channels = await this.#enumerateChannels(base)
    const selectedId =
      storedChannelId !== undefined && channels.some((channel) => channel.id === storedChannelId)
        ? storedChannelId
        : DEFAULT_CHANNEL
    const authed = selectedId === DEFAULT_CHANNEL ? base : await this.#createAuthed(jar, selectedId)
    if (epoch !== undefined && epoch !== this.#epoch) {
      // A login/logout/channel switch won the race — this restored session is stale; installing
      // it would resurrect credentials the user replaced or logged out of.
      return
    }
    this.#jar = jar
    this.#channels = channels
    this.#selectedId = selectedId
    this.#authed = authed
  }

  /**
   * List the channels this account can post as. The selected identity becomes the
   * `default` entry (no delegation); brand channels carry their page id. `getInfo(true)`
   * must run on a non-delegated instance, so this is only called from {@link #activate}.
   */
  async #enumerateChannels(base: Innertube): Promise<YouTubeChannel[]> {
    try {
      const accounts = await base.account.getInfo(true)
      const channels: YouTubeChannel[] = []
      for (const item of accounts) {
        if (!item.has_channel) {
          continue
        }
        const id = item.is_selected ? DEFAULT_CHANNEL : extractPageId(item)
        if (id === undefined) {
          continue
        }
        const channel: YouTubeChannel = { id, name: item.account_name.toString() }
        const handle = item.channel_handle.toString()
        if (handle !== '') {
          channel.handle = handle
        }
        const avatar = largestThumbnailUrl(item.account_photo)
        if (avatar !== undefined) {
          channel.avatarUrl = avatar
        }
        channels.push(channel)
      }
      return channels
    } catch (error) {
      // This is the first authenticated request after restoring cookies, so it doubles as a
      // session check: an auth error means the stored cookies are dead — propagate it so
      // init() discards them (the UI then shows logged-out rather than a broken "signed in").
      if (isAuthError(error)) {
        throw error
      }
      // Any other failure is transient: keep the session, just without the channel list.
      return []
    }
  }

  /**
   * Send a chat message to a live video as the logged-in channel. `emojiMap` (`:shortcut:` → emojiId
   * for the chat's proprietary emojis) converts typed shortcuts into emoji segments so they render as
   * images instead of literal text.
   */
  async sendMessage(
    videoId: string,
    channelId: string | undefined,
    text: string,
    emojiMap: Map<string, string> = new Map()
  ): Promise<void> {
    if (this.#authed === undefined) {
      throw new Error('Log in to YouTube to send messages')
    }
    await this.#withAuthRecovery(() => this.#deliver(videoId, channelId, text, emojiMap))
  }

  /**
   * The right-click actions available on a chat message for the signed-in account, from YouTube's
   * per-message "⋮" menu. The returned set already reflects the account's role in that chat (viewer
   * block, or moderator/streamer remove/timeout/ban), so the client surfaces it as-is. Returns an
   * empty list when logged out or on any failure — chat actions are best-effort UI. A stale-auth
   * 401/403 recovers once (rotate/rebuild/reconnect) so the menu isn't lost to an aged-out session.
   */
  async getMessageActions(menuToken: string): Promise<ChatAction[]> {
    return this.#readWithAuthRecovery<ChatAction[]>(async (yt) => {
      const response = await yt.actions.execute('live_chat/get_item_context_menu', {
        params: menuToken,
        parse: false
      })
      const actions = parseMenuActions(response.data)
      this.#log(`message actions: [${actions.map((a) => `${a.id}:${a.label}`).join(', ')}]`)
      return actions
    }, [])
  }

  /**
   * Run one of {@link getMessageActions}'s actions on a message. Re-fetches the menu (the token is
   * stable) and executes the chosen item's endpoint. An endpoint that opens a confirmation dialog
   * (block) is first resolved to the dialog's confirm button — the UI already confirmed the action.
   * A moderation action (remove / timeout / hide-user / unhide / block) carries a
   * `moderateLiveChatEndpoint` whose params the web client POSTs to `live_chat/moderate`; do exactly
   * that as the signed-in (and, for a brand channel, delegated) account. Any other endpoint is
   * executed verbatim from the response. Throws with a user-facing message on failure.
   */
  async runMessageAction(
    menuToken: string,
    actionId: string,
    timeoutSeconds?: number
  ): Promise<void> {
    if (this.#authed === undefined) {
      throw new Error('Log in to YouTube to use chat actions')
    }
    await this.#withAuthRecovery(async (yt) => {
      const response = await yt.actions.execute('live_chat/get_item_context_menu', {
        params: menuToken,
        parse: false
      })
      const menuEndpoint = findActionEndpoint(response.data, actionId)
      if (menuEndpoint === undefined) {
        throw new Error('That action is no longer available')
      }
      const endpoint = resolveConfirmDialog(menuEndpoint)
      if (endpoint === undefined) {
        throw new Error('YouTube changed how this action works — nothing was done')
      }
      // Remove / hide carry a direct moderate endpoint. A timeout instead opens a duration dialog
      // whose options each hold YouTube's own per-duration moderate params; pick the chosen one.
      const params =
        timeoutSeconds !== undefined
          ? timeoutParams(endpoint, timeoutSeconds)
          : moderationParams(endpoint)
      if (params !== undefined) {
        this.#log(`running moderation action ${actionId} via live_chat/moderate`)
        await yt.actions.execute('live_chat/moderate', { params, parse: false })
        return
      }
      if (timeoutSeconds !== undefined) {
        throw new Error('That timeout duration is no longer available')
      }
      this.#log(`running message action ${actionId}`)
      await new YTNodes.NavigationEndpoint(endpoint).call(yt.actions, { parse: false })
    })
  }

  /**
   * Run a held-for-review message's inline action (its {@link HeldAction.token}, an opaque encoding
   * of YouTube's own button endpoint). A held review button carries a `moderateLiveChatEndpoint`
   * whose params the web client POSTs to `live_chat/moderate`; replay that exactly. A token that does
   * not resolve to such params is rejected — never executed as an arbitrary endpoint — so a forged
   * token or YouTube shape drift can't drive the authed account to an unintended endpoint. Throws
   * with a user-facing message on failure.
   */
  async runHeldAction(token: string): Promise<void> {
    if (this.#authed === undefined) {
      throw new Error('Log in to YouTube to use chat actions')
    }
    const endpoint = decodeHeldToken(token)
    const params = endpoint === undefined ? undefined : deepModerationParams(endpoint)
    if (params === undefined) {
      throw new Error('That action is no longer available')
    }
    await this.#withAuthRecovery(async (yt) => {
      this.#log('running held action via live_chat/moderate')
      await yt.actions.execute('live_chat/moderate', { params, parse: false })
    })
  }

  /**
   * Whether the signed-in user is currently blocked from chatting on a live video, and why.
   * Returns the restriction text (e.g. "Subscribers-only mode") when YouTube would reject a send,
   * or undefined when the user can chat or we can't tell. Probed from an authenticated
   * `get_live_chat`, whose action panel reflects the requesting account — so it captures
   * subscribers-only / members-only chat that a logged-out read can't see. A stale-auth probe
   * recovers once so the restriction reflects the live session, not a dead one.
   */
  async checkSendRestriction(continuation: string): Promise<string | undefined> {
    // A probe failure must not block sending (the send path still reports a held message), but a
    // stale-auth probe recovers once so the restriction reflects the live session, not a dead one.
    return this.#readWithAuthRecovery<string | undefined>(async (yt) => {
      const response = await yt.actions.execute('live_chat/get_live_chat', {
        continuation,
        parse: false
      })
      return restrictionReason(response.data as RawChatRestriction)
    }, undefined)
  }

  /**
   * The live-chat initial snapshot, fetched as the signed-in moderator from the `live_chat` HTML
   * page (`ytInitialData`) — the same data the browser's chat iframe loads. The reader extracts the
   * "Moderation activity" continuation from this snapshot and switches its polling to it, so the
   * held-for-review queue keeps arriving. The shape matches a `get_live_chat` response
   * (`continuationContents.liveChatContinuation`), so the reader processes it identically. The
   * brand-channel page id rides in the URL (as on the browser's chat iframe) so the page renders the
   * moderator's view. Returns undefined when logged out or on any failure — the reader then just
   * polls the API.
   */
  async fetchLiveChatBootstrap(
    continuation: string,
    videoId?: string
  ): Promise<unknown | undefined> {
    if (this.#authed === undefined) {
      return undefined
    }
    const pageId =
      this.#selectedId === DEFAULT_CHANNEL ? '' : `&pageId=${encodeURIComponent(this.#selectedId)}`
    const url = `https://www.youtube.com/live_chat?continuation=${encodeURIComponent(continuation)}${pageId}`
    // Mirror the browser's plain navigation GET (HTML Accept + watch-page Referer), not an XHR/iframe.
    const headers: Record<string, string> = {
      'User-Agent': this.#userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9'
    }
    if (videoId !== undefined) {
      headers['Referer'] = `https://www.youtube.com/live/${videoId}`
    }
    // This GET sits on the critical path that gates the reader's first poll (YouTubeSource awaits it
    // before reader.start). A hung connection would never reject, so bound it: on timeout the abort
    // makes the fetch reject, the catch yields undefined, and the reader falls back to plain polling.
    const fetchPage = async (): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, BOOTSTRAP_TIMEOUT_MS)
      try {
        return await this.#makeFetch(this.#jar)(url, { headers, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      let response = await fetchPage()
      if (response.status === 401 || response.status === 403) {
        // Stale rotating cookie — refresh the session in place (no reconnect: we're already inside a
        // connect) and retry once, so the moderator bootstrap doesn't silently miss the held queue.
        await this.#recoverStaleReadSession(false)
        response = await fetchPage()
      }
      if (!response.ok) {
        this.#log(`live_chat bootstrap: HTTP ${response.status}`)
        return undefined
      }
      const data = extractYtInitialData(await response.text())
      if (data === undefined) {
        this.#log('live_chat bootstrap: no ytInitialData in page')
        return undefined
      }
      if (this.#debug) {
        // Serializing the whole page snapshot is only for the diagnostic count — skip it otherwise.
        const held = (JSON.stringify(data).match(/liveChatAutoModMessageRenderer/g) ?? []).length
        this.#log(`live_chat bootstrap: loaded (${held} held-for-review item(s))`)
      }
      return data
    } catch (error) {
      this.#log(`live_chat bootstrap failed: ${error instanceof Error ? error.message : error}`)
      return undefined
    }
  }

  /**
   * The chat's proprietary emoji catalog, fetched as the signed-in user — the emoji picker rides on
   * the authenticated message-input renderer, which the anonymous reader never sees. Returns an
   * empty list when logged out or on any failure (the picker just won't list YouTube emojis). A
   * stale-auth read recovers once so a rotated session keeps the catalog.
   */
  async getEmojiCatalog(continuation: string): Promise<YouTubeEmoji[]> {
    // Recovers once from a stale-auth read so a rotated session doesn't leave the picker without the
    // account's emoji catalog; any other failure degrades to an empty list.
    return this.#readWithAuthRecovery<YouTubeEmoji[]>(async (yt) => {
      const response = await yt.actions.execute('live_chat/get_live_chat', {
        continuation,
        parse: false
      })
      const emojis = collectEmojis(response.data)
      this.#log(`emoji catalog — ${emojis.length} emojis`)
      return emojis
    }, [])
  }

  /** The authed InnerTube, or throw — read fresh each time so a recovery rebuild is picked up. */
  #requireAuthed(): Innertube {
    if (this.#authed === undefined) {
      throw new Error('Log in to YouTube first')
    }
    return this.#authed
  }

  /**
   * Run a write/moderation action against the authed session, recovering once from a stale rotating
   * token. Every write (send, moderate, held-queue action) authenticates with the same jar, so they
   * share one failure mode: a 401/403 means `__Secure-1PSIDTS` aged out (typically the browser
   * rotated it out from under us — reads only degrade silently, but writes reject). Rotate to catch
   * up, rebuild the instance from the refreshed jar, retry, and — on success — fire {@link #onChange}
   * so the open readers reconnect onto the rebuilt instance instead of polling the superseded one. A
   * second auth failure means the cookies are genuinely dead → log out cleanly so the renderer prompts
   * for a fresh login. Non-auth errors (a held/rejected send, an unavailable action) propagate unchanged.
   */
  async #withAuthRecovery<T>(operation: (yt: Innertube) => Promise<T>): Promise<T> {
    try {
      return await operation(this.#requireAuthed())
    } catch (error) {
      if (!isAuthError(error)) {
        throw error
      }
      this.#log('action rejected (auth) — rotating cookies, rebuilding session, and retrying')
      let rebuilt = false
      try {
        await this.#rotateAndRebuild()
        rebuilt = true
        const result = await operation(this.#requireAuthed())
        this.#onChange()
        return result
      } catch (retryError) {
        if (!rebuilt || isAuthError(retryError)) {
          this.#log('recovery failed — logging out (YouTube session expired)')
          this.logout()
          throw new Error('Your YouTube session expired — please log in to YouTube again')
        }
        // The session was rebuilt, but the retried write failed for a non-auth reason (slow mode, a
        // held/rejected send, an unavailable action). Still reconnect readers onto the rebuilt
        // instance before propagating, so they don't keep polling the superseded one.
        this.#onChange()
        throw retryError
      }
    }
  }

  /**
   * Recover the live-chat reader's READ path after a 401/403 poll failure from a stale rotating
   * cookie: rotate, rebuild, and reconnect the open readers onto the rebuilt instance. Called by the
   * source on the reader's `onAuthError`. A no-op when logged out.
   */
  async recoverReads(): Promise<void> {
    await this.#recoverStaleReadSession(true)
  }

  /**
   * Refresh a stale read session in place: rotate the cookies once and rebuild the authed instance,
   * then (when `reconnect`) fire {@link #onChange} so open readers re-bind to the rebuilt instance.
   * Debounced ({@link READ_RECOVERY_DEBOUNCE_MS}) because {@link #rotateCookies} is single-use — a
   * burst of read 401s (poll, menu, restriction probe) rotates at most once per window. Error-safe:
   * a failed rotate/rebuild logs and leaves the session as-is, and it never logs out — a background
   * read must not sign the moderator out mid-session. Callers read the (possibly rebuilt) authed
   * instance fresh afterwards. `reconnect` is false on the bootstrap path, which already runs inside
   * a connect and must not trigger a reconnect of itself.
   */
  async #recoverStaleReadSession(reconnect: boolean): Promise<void> {
    if (this.#authed === undefined) {
      return
    }
    const now = Date.now()
    if (now - this.#lastReadRecovery < READ_RECOVERY_DEBOUNCE_MS) {
      // Rotation is debounced, but if an earlier recovery rebuilt auth without reconnecting (the
      // bootstrap path), still reconnect now so the open reader rebinds to the already-rebuilt
      // instance instead of polling the superseded one until the debounce window passes.
      if (reconnect && this.#reconnectPending) {
        this.#reconnectPending = false
        this.#onChange()
      }
      return
    }
    this.#lastReadRecovery = now
    this.#log('read rejected (auth) — rotating cookies and rebuilding the read session')
    try {
      await this.#rotateAndRebuild()
    } catch (error) {
      this.#log(`read recovery failed: ${error instanceof Error ? error.message : error}`)
      return
    }
    if (reconnect) {
      this.#reconnectPending = false
      this.#onChange()
    } else {
      // Rebuilt the session but left the open readers on the old instance (we're inside a connect);
      // remember that a reconnect is owed so the reader's next auth-error recovery fires it.
      this.#reconnectPending = true
    }
  }

  /**
   * Run a best-effort authed READ (the per-message action menu, send-restriction probe, emoji
   * catalog), recovering once from a stale rotating token: on a 401/403 rotate, rebuild, reconnect
   * the open readers, and retry. Unlike {@link #withAuthRecovery} it never logs out or throws on a
   * dead session — a background read must degrade to `fallback`, not sign the moderator out
   * mid-session. Returns `fallback` when logged out, on a non-auth failure, or if the retry still
   * fails.
   */
  async #readWithAuthRecovery<T>(
    operation: (yt: Innertube) => Promise<T>,
    fallback: T
  ): Promise<T> {
    const yt = this.#authed
    if (yt === undefined) {
      return fallback
    }
    try {
      return await operation(yt)
    } catch (error) {
      if (!isAuthError(error)) {
        return fallback
      }
      await this.#recoverStaleReadSession(true)
      const rebuilt = this.#authed
      if (rebuilt === undefined) {
        return fallback
      }
      try {
        return await operation(rebuilt)
      } catch {
        return fallback
      }
    }
  }

  /** Rotate the session cookies and rebuild the authed instance from the refreshed jar. */
  async #rotateAndRebuild(): Promise<void> {
    await this.#rotateCookies()
    await this.#rebuildAuthed()
  }

  /**
   * Deliver one message, replicating the web client's send_message request with rich text segments
   * (typed `:shortcut:`s become emoji segments) and a hand-built `params` token — youtubei.js's own
   * `LiveChat.sendMessage` only sends plain text. The send only needs the video + channel id, both
   * of which the source already knows, skipping youtubei.js's heavy `getInfo` (a full watch-page
   * fetch + parse) that otherwise gates every first send. `parse: false`: the raw response is read
   * by {@link #confirmDelivery} — a strict parse would throw on any unmodeled sibling action and
   * report a delivered message as failed.
   */
  async #deliver(
    videoId: string,
    channelId: string | undefined,
    text: string,
    emojiMap: Map<string, string>
  ): Promise<void> {
    const yt = this.#authed
    if (yt === undefined) {
      throw new Error('Log in to YouTube to send messages')
    }
    const targetChannelId = channelId ?? (await this.#fetchChannelId(yt, videoId))
    const postStartedAt = SEND_DEBUG ? performance.now() : 0
    const response = await yt.actions.execute('/live_chat/send_message', {
      richMessage: { textSegments: buildTextSegments(text, emojiMap) },
      clientMessageId: randomUUID(),
      client: 'WEB',
      params: encodeSendParams(videoId, targetChannelId),
      parse: false
    })
    if (SEND_DEBUG) {
      this.#sendLog(`send_message request ${Math.round(performance.now() - postStartedAt)}ms`)
    }
    this.#confirmDelivery(response.data)
  }

  /** Unconditional stdout line for send tracing (gated at the call site by SEND_DEBUG). */
  #sendLog(message: string): void {
    console.log(`[send] youtube: ${message}`)
  }

  /** Fallback when the caller doesn't know the stream's channel id: fetch it (slow path). */
  async #fetchChannelId(yt: Innertube, videoId: string): Promise<string> {
    const infoStartedAt = SEND_DEBUG ? performance.now() : 0
    const info = await yt.getInfo(videoId)
    if (SEND_DEBUG) {
      this.#sendLog(
        `getInfo fallback (no channelId) ${Math.round(performance.now() - infoStartedAt)}ms`
      )
    }
    if (!info.livechat) {
      throw new Error('This stream has no live chat')
    }
    const channelId = info.basic_info.channel_id
    if (channelId === undefined) {
      throw new Error("Could not determine this stream's channel — try again")
    }
    return channelId
  }

  /**
   * Throw a user-facing error when the raw send_message response shows the message was not
   * delivered: a *held* message echoes a `dimChatItemAction` (YouTube telling its client to dim the
   * optimistic copy it showed), and an explicit error payload is a rejection. Anything else on an
   * HTTP-ok response counts as posted (see {@link classifySendResponse}) — reporting a delivered
   * message as failed invites duplicate resends. Auth/network failures throw from the request
   * itself and propagate to the caller's rotate/rebuild recovery.
   */
  #confirmDelivery(data: unknown): void {
    const outcome = classifySendResponse(data)
    if (outcome.kind === 'held') {
      this.#log('send held by YouTube (dim-chat-item echo)')
      throw new Error(
        'YouTube held your message — it was not posted (held for review, a duplicate, or sent too fast)'
      )
    }
    if (outcome.kind === 'rejected') {
      this.#log(`send rejected by YouTube — ${outcome.message ?? 'no error message'}`)
      throw new Error(
        outcome.message === undefined
          ? 'YouTube returned an error — delivery is unconfirmed, check the chat before resending'
          : `YouTube rejected your message: ${outcome.message}`
      )
    }
  }

  /** Re-create the authed InnerTube from the current jar so its baked-in cookie/auth is fresh. */
  async #rebuildAuthed(): Promise<void> {
    const onBehalfOfUser = this.#selectedId === DEFAULT_CHANNEL ? undefined : this.#selectedId
    this.#authed = await this.#createAuthed(this.#jar, onBehalfOfUser)
  }

  /**
   * Build and validate an authenticated InnerTube bound to `jar`; does not mutate live state.
   * `onBehalfOfUser` (a channel page id) makes write actions post as that brand channel.
   */
  async #createAuthed(jar: Map<string, string>, onBehalfOfUser?: string): Promise<Innertube> {
    const visitorData = this.#getVisitorData()
    // Never enable player retrieval / session caching / OAuth here without an explicit cache
    // directory under userData: youtubei.js's default cache path resolves inside app.asar
    // (read-only), so it works in dev but crashes every packaged build on first write.
    const yt = await Innertube.create({
      cookie: jarString(jar),
      user_agent: this.#userAgent,
      retrieve_player: false,
      fetch: this.#makeFetch(jar),
      ...(visitorData !== undefined ? { visitor_data: visitorData } : {}),
      ...(onBehalfOfUser !== undefined ? { on_behalf_of_user: onBehalfOfUser } : {})
    })
    if (!yt.session.logged_in) {
      throw new NotLoggedInError()
    }
    return yt
  }

  /**
   * Fetch bound to a specific jar: sends it (so rotated cookies go out) and captures
   * `Set-Cookie` back into it. Persists only when `jar` is the live jar, so validation
   * of a candidate session never writes over the stored cookies. youtubei.js bakes its
   * own copy of the cookie at create time and derives the SAPISIDHASH from it, so when a
   * rotation here diverges from that copy, writes 401 — {@link sendMessage} recovers by
   * rebuilding the instance from this jar.
   */
  #makeFetch(jar: Map<string, string>): typeof fetch {
    return async (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      // Attach the Google session cookies (and accept Set-Cookie back) only for YouTube hosts,
      // so a cross-origin redirect or future reuse of this instance can't leak the jar elsewhere.
      const youtube = isYouTubeRequest(input)
      const cookie = jarString(jar)
      if (youtube && cookie !== '') {
        headers.set('Cookie', cookie)
      }
      // Isolate the send_message request's network time from youtubei.js's surrounding
      // param-building and response parse (`parse: true`), to see how much of the send is YouTube.
      const traceSend = SEND_DEBUG && /\/live_chat\/send_message/.test(requestUrl(input))
      const fetchStartedAt = traceSend ? performance.now() : 0
      if (traceSend) {
        // The exact rich message being sent (text + emoji segments), whichever path built it.
        this.#sendLog(`send_message body ${sendBodySummary(init?.body)}`)
      }
      // Pass `init` through (body, method, signal, ...). youtubei.js calls this
      // fetch as fetch(request, { body: contextInjectedBody, ... }); dropping init
      // would send a body without the required InnerTube `context`, breaking sends.
      const response = await proxiedFetch(input, { ...init, headers })
      if (traceSend) {
        // Flag whether the request tunneled through a debugging proxy (PROXY_URL): a local
        // TLS-intercepting proxy adds latency to every request, including this send.
        const proxy = proxyUrl()
        const route = proxy !== undefined ? `via proxy ${proxy}` : 'direct'
        const ms = Math.round(performance.now() - fetchStartedAt)
        this.#sendLog(`network only (send_message fetch) ${ms}ms [${route}]`)
      }
      // Merge Set-Cookie only when both the request and the final response are YouTube hosts,
      // so a redirect to another origin can't inject cookies into the persisted Google jar.
      if (youtube && isYouTubeRequest(response.url)) {
        const setCookies = response.headers.getSetCookie?.() ?? []
        const changed = setCookies.length > 0 ? applySetCookies(jar, setCookies) : []
        if (changed.length > 0 && jar === this.#jar) {
          this.#persist()
          this.#log(`cookies rotated: ${changed.join(', ')}`)
        }
      }
      return response
    }
  }

  /**
   * Refresh the rotating session cookies (`__Secure-1PSIDTS`/`__Secure-3PSIDTS`) via YouTube's
   * RotateCookies endpoint — the only way to keep a pasted session alive like a browser. A
   * one-time token is read from the RotateCookiesPage JS, then POSTed to RotateCookies; the
   * fresh `Set-Cookie` is captured into the jar by `#makeFetch`. Best effort — a failure just
   * lets the cookies age, which the restore/send checks then surface as a dead session.
   */
  async #rotateCookies(): Promise<void> {
    const fetcher = this.#makeFetch(this.#jar)
    try {
      const page = await fetcher(ROTATE_PAGE_URL, { headers: { 'User-Agent': this.#userAgent } })
      if (!page.ok) {
        this.#log(`rotate: RotateCookiesPage ${page.status}`)
        return
      }
      const token = /init\(\s*['"](-?\d+)['"]/.exec(await page.text())?.[1]
      if (token === undefined) {
        this.#log('rotate: no rotation token found')
        return
      }
      const result = await fetcher(ROTATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.youtube.com',
          'User-Agent': this.#userAgent
        },
        body: JSON.stringify([null, token, 1])
      })
      await result.body?.cancel().catch(() => {
        // ignore
      })
      this.#log(`rotate: RotateCookies ${result.status}`)
    } catch {
      // Best effort — transient failures don't end the session.
    }
  }

  #persist(): void {
    const stored: StoredYouTube = { cookie: jarString(this.#jar) }
    if (this.#selectedId !== DEFAULT_CHANNEL) {
      stored.channelId = this.#selectedId
    }
    this.#store.set(STORE_KEY, stored)
  }
}
