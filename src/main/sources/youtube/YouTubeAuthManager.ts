import { randomUUID } from 'node:crypto'
import { Innertube, YTNodes } from 'youtubei.js'
import type { AuthStore } from '@main/auth/AuthStore'
import type { ChatAction, YouTubeChannel } from '@shared/model'
import { proxiedFetch, proxyUrl } from '@main/net/proxy'
import { isYouTubeHost } from '@main/sources/channelId'
import {
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

/** Parse a pasted `Cookie` header / `name=value` blob into a fresh jar. */
function parseJar(raw: string): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of raw.split(/[;\n]/)) {
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

/** Whether a fetch input targets a YouTube host (so the session cookies may be attached). */
function isYouTubeRequest(input: Parameters<typeof fetch>[0]): boolean {
  try {
    return isYouTubeHost(new URL(requestUrl(input)).hostname)
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

/** youtubei.js surfaces an HTTP error as `…failed with status code <n>`; treat 401/403 as auth. */
function isAuthError(error: unknown): boolean {
  return error instanceof Error && /failed with status code (401|403)/.test(error.message)
}

/**
 * Holds the YouTube login from pasted browser cookies (Google blocks embedded /
 * automated sign-in). Keeps a live cookie jar that captures `Set-Cookie` rotation
 * from every authenticated request (mirroring how a browser stays signed in) and
 * persists it; a stale rotating token is refreshed on demand at restore and on a
 * rejected send (see {@link sendMessage}), not on a timer. Provides an authenticated
 * InnerTube used only for sending; reading stays on the separate unauthenticated
 * instance. `onChange` fires on login/logout.
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
      // Discard the credentials only when the session genuinely failed auth (dead cookies). A
      // transient failure (offline launch, 5xx) stays logged out for now but keeps the stored
      // cookies so the next launch can restore the session.
      if (isAuthError(error)) {
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
    try {
      await this.#deliver(videoId, channelId, text, emojiMap)
    } catch (error) {
      if (!isAuthError(error)) {
        throw error
      }
      // A write rejected with auth means our rotating session token (`__Secure-1PSIDTS`) has
      // gone stale — typically the browser rotated it. Rotate to catch up, rebuild from the
      // refreshed jar, and retry once.
      this.#log('send rejected (auth) — rotating cookies, rebuilding session, and retrying')
      await this.#recoverSend(videoId, channelId, text, emojiMap)
    }
  }

  /**
   * The right-click actions available on a chat message for the signed-in account, from YouTube's
   * per-message "⋮" menu. The returned set already reflects the account's role in that chat (viewer
   * block, or moderator/streamer remove/timeout/ban), so the client surfaces it as-is. Returns an
   * empty list when logged out or on any failure — chat actions are best-effort UI.
   */
  async getMessageActions(menuToken: string): Promise<ChatAction[]> {
    const yt = this.#authed
    if (yt === undefined) {
      return []
    }
    try {
      const response = await yt.actions.execute('live_chat/get_item_context_menu', {
        params: menuToken,
        parse: false
      })
      const actions = parseMenuActions(response.data)
      this.#log(`message actions: [${actions.map((a) => `${a.id}:${a.label}`).join(', ')}]`)
      return actions
    } catch (error) {
      this.#log(`get message actions failed: ${error instanceof Error ? error.message : error}`)
      return []
    }
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
    const yt = this.#authed
    if (yt === undefined) {
      throw new Error('Log in to YouTube to use chat actions')
    }
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
  }

  /**
   * Whether the signed-in user is currently blocked from chatting on a live video, and why.
   * Returns the restriction text (e.g. "Subscribers-only mode") when YouTube would reject a send,
   * or undefined when the user can chat or we can't tell. Probed from an authenticated
   * `get_live_chat`, whose action panel reflects the requesting account — so it captures
   * subscribers-only / members-only chat that a logged-out read can't see.
   */
  async checkSendRestriction(continuation: string): Promise<string | undefined> {
    const yt = this.#authed
    if (yt === undefined) {
      return undefined
    }
    try {
      const response = await yt.actions.execute('live_chat/get_live_chat', {
        continuation,
        parse: false
      })
      return restrictionReason(response.data as RawChatRestriction)
    } catch {
      // A probe failure must not block sending; the send path still reports a held message.
      return undefined
    }
  }

  /**
   * The chat's proprietary emoji catalog, fetched as the signed-in user — the emoji picker rides on
   * the authenticated message-input renderer, which the anonymous reader never sees. Returns an
   * empty list when logged out or on any failure (the picker just won't list YouTube emojis).
   */
  async getEmojiCatalog(continuation: string): Promise<YouTubeEmoji[]> {
    const yt = this.#authed
    if (yt === undefined) {
      return []
    }
    try {
      const response = await yt.actions.execute('live_chat/get_live_chat', {
        continuation,
        parse: false
      })
      const emojis = collectEmojis(response.data)
      this.#log(`emoji catalog — ${emojis.length} emojis`)
      return emojis
    } catch (error) {
      this.#log(`emoji catalog fetch failed: ${error instanceof Error ? error.message : error}`)
      return []
    }
  }

  /** Rotate + rebuild, then retry the send; if it still can't authenticate, log out cleanly. */
  async #recoverSend(
    videoId: string,
    channelId: string | undefined,
    text: string,
    emojiMap: Map<string, string>
  ): Promise<void> {
    let rebuilt = false
    try {
      await this.#rotateCookies()
      await this.#rebuildAuthed()
      rebuilt = true
      await this.#deliver(videoId, channelId, text, emojiMap)
    } catch (error) {
      // Rebuild failed (cookies no longer sign in) or the retry was still rejected → the
      // session is genuinely dead. Log out so the renderer prompts for a fresh login,
      // instead of leaving a "signed in" state that can never send.
      if (!rebuilt || isAuthError(error)) {
        this.#log('recovery failed — logging out (YouTube session expired)')
        this.logout()
        throw new Error('Your YouTube session expired — please log in to YouTube again')
      }
      throw error
    }
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
      throw new Error('Those cookies are not signed in to YouTube — copy them while logged in')
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
