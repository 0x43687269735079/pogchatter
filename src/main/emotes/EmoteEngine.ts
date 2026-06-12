import type { EmoteProviderSettings, Fragment, Platform } from '@shared/model'
import type { ResolvedEmote } from '@main/emotes/types'
import {
  fetchSevenTvChannel,
  fetchSevenTvGlobal,
  type SevenTvSet
} from '@main/emotes/providers/sevenTv'
import { fetchBttvChannel, fetchBttvGlobal } from '@main/emotes/providers/bttv'
import { fetchFfzChannel, fetchFfzGlobal } from '@main/emotes/providers/ffz'
import {
  SevenTvEvents,
  type SevenTvSetChange,
  type SocketFactory
} from '@main/emotes/SevenTvEvents'

type EmoteIndex = Map<string, ResolvedEmote>

interface ScopeTag {
  scope: 'global' | 'channel' | 'library'
}

/**
 * One scope's third-party lists, kept after indexing so the 7TV slice can be
 * live-updated by the EventAPI and the scope's index rebuilt in place.
 */
interface ThirdPartyLists {
  ffz: ResolvedEmote[]
  bttv: ResolvedEmote[]
  sevenTv: ResolvedEmote[]
}

/** Lists are passed in increasing precedence; later entries override earlier ones. */
function buildIndex(lists: ResolvedEmote[][]): EmoteIndex {
  const index: EmoteIndex = new Map()
  for (const list of lists) {
    for (const emote of list) {
      if (emote.code !== '' && emote.url !== '') {
        index.set(emote.code, emote)
      }
    }
  }
  return index
}

/** Index a scope's lists, dropping disabled providers so their emotes never tokenize. */
function indexLists(lists: ThirdPartyLists, enabled: EmoteProviderSettings): EmoteIndex {
  return buildIndex([
    enabled.ffz ? lists.ffz : [],
    enabled.bttv ? lists.bttv : [],
    enabled.sevenTv ? lists.sevenTv : []
  ])
}

const ALL_PROVIDERS_ENABLED: EmoteProviderSettings = { sevenTv: true, bttv: true, ffz: true }

// A failed provider fetch is retried until it succeeds (a long chat session should
// recover its emotes when the network returns), backing off 30s → 5min.
const RETRY_BASE_MS = 30_000
const RETRY_CAP_MS = 300_000

/** What a skipped 7TV fetch yields: no set id (so no EventAPI watch) and no emotes. */
function emptySevenTvSet(): SevenTvSet {
  return { setId: undefined, emotes: [] }
}

/**
 * One scope's settled provider fetches. Failed providers fall back to the scope's
 * previous list (nothing on first load), and `complete` is false so the scope retries.
 */
interface ProviderLoad {
  lists: ThirdPartyLists
  sevenTvSetId: string | undefined
  complete: boolean
}

async function settleProviders(
  fetches: [
    Promise<ResolvedEmote[]> | ResolvedEmote[],
    Promise<ResolvedEmote[]> | ResolvedEmote[],
    Promise<SevenTvSet> | SevenTvSet
  ],
  previous: ThirdPartyLists | undefined
): Promise<ProviderLoad> {
  const [ffz, bttv, sevenTv] = await Promise.allSettled(fetches)
  const sevenTvSet = sevenTv.status === 'fulfilled' ? sevenTv.value : undefined
  return {
    lists: {
      ffz: ffz.status === 'fulfilled' ? ffz.value : (previous?.ffz ?? []),
      bttv: bttv.status === 'fulfilled' ? bttv.value : (previous?.bttv ?? []),
      sevenTv: sevenTvSet?.emotes ?? previous?.sevenTv ?? []
    },
    sevenTvSetId: sevenTvSet?.setId,
    complete:
      ffz.status === 'fulfilled' && bttv.status === 'fulfilled' && sevenTv.status === 'fulfilled'
  }
}

/** Mutate the 7TV slice: drop removed (and replaced) codes, then append the additions. */
function mutateSevenTv(lists: ThirdPartyLists, change: SevenTvSetChange): void {
  const dropped = new Set(change.removeCodes)
  for (const emote of change.add) {
    dropped.add(emote.code)
  }
  const kept = lists.sevenTv.filter((emote) => !dropped.has(emote.code))
  kept.push(...change.add)
  lists.sevenTv = kept
}

/**
 * Loads and caches 7TV/BTTV/FFZ emotes (global + per channel) plus Twitch native
 * emotes (from Helix), and tokenizes message text against them. Loaded 7TV sets are
 * kept live by a lazily started EventAPI client (`SevenTvEvents`).
 *
 * Lookup precedence, highest first: the current channel's third-party emotes, the
 * shared "library" (every added channel's third-party emotes + this account's own,
 * applied in *every* column), third-party global, Twitch channel, Twitch global;
 * within a third-party scope it's FFZ < BTTV < 7TV. The library + Twitch global layers
 * render everywhere so a 7TV/Twitch emote typed in a YouTube chat still shows for any
 * pogchatter/extension viewer; per-channel layers apply only in their own column.
 */
export class EmoteEngine {
  #global: EmoteIndex = new Map()
  readonly #channels = new Map<string, EmoteIndex>()
  readonly #pending = new Map<string, Promise<void>>()
  /** This account's own 7TV/BTTV/FFZ emotes (from its Twitch identity). */
  #userEmotes: EmoteIndex = new Map()
  /** Merged pool of every added channel's third-party emotes + #userEmotes; applied everywhere. */
  #shared: EmoteIndex = new Map()
  /** Twitch global + this account's usable emotes (Helix); applied in every column. */
  #twitchGlobal: EmoteIndex = new Map()
  /** Twitch channel emotes keyed by room id; applied only in that Twitch channel. */
  readonly #twitchChannels = new Map<string, EmoteIndex>()
  /** A YouTube channel's proprietary/member emojis, keyed by channel id; for the picker only. */
  readonly #youtubeEmojis = new Map<string, EmoteIndex>()
  /** Source lists per scope, kept so 7TV live updates can rebuild the affected index. */
  #globalLists: ThirdPartyLists | undefined
  readonly #channelLists = new Map<string, ThirdPartyLists>()
  #userLists: ThirdPartyLists | undefined
  /** Every ensured channel's identity, kept so provider toggles can re-fetch known scopes. */
  readonly #channelScopes = new Map<string, { platform: Platform; channelId: string }>()
  /** The identity loadUserEmotes was last called with, kept for the same re-fetch. */
  #userScope: { platform: Platform; channelId: string } | undefined
  /** Pending failure retries per scope key ('global', 'user', or `platform:id`). */
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #retryAttempts = new Map<string, number>()
  /** 7TV emote-set id → the scopes it backs: 'global', 'user', or a `platform:id` channel key. */
  readonly #sevenTvScopes = new Map<string, Set<string>>()
  #sevenTvEvents: SevenTvEvents | undefined
  readonly #createSocket: SocketFactory | undefined
  readonly #providers: () => EmoteProviderSettings
  #disposed = false

  constructor(createSocket?: SocketFactory, providers?: () => EmoteProviderSettings) {
    this.#createSocket = createSocket
    this.#providers = providers ?? ((): EmoteProviderSettings => ALL_PROVIDERS_ENABLED)
  }

  #indexLists(lists: ThirdPartyLists): EmoteIndex {
    return indexLists(lists, this.#providers())
  }

  /** Load global third-party emotes; failed providers keep retrying in the background. */
  async loadGlobals(): Promise<void> {
    const enabled = this.#providers()
    const load = await settleProviders(
      [
        enabled.ffz ? fetchFfzGlobal() : [],
        enabled.bttv ? fetchBttvGlobal() : [],
        enabled.sevenTv ? fetchSevenTvGlobal() : emptySevenTvSet()
      ],
      this.#globalLists
    )
    if (this.#disposed) {
      return
    }
    this.#globalLists = load.lists
    this.#global = this.#indexLists(load.lists)
    this.#watchSevenTvSet(load.sevenTvSetId, 'global')
    this.#settleRetry('global', load.complete, () => this.loadGlobals())
  }

  /** Idempotently begin loading a channel's emotes (fire-and-forget). */
  ensureChannel(platform: Platform, channelId: string): void {
    const key = `${platform}:${channelId}`
    // Always (re)register the scope: a release during an in-flight load must not win
    // over a re-add, and the load's apply step checks this registry.
    this.#channelScopes.set(key, { platform, channelId })
    if (this.#channels.has(key) || this.#pending.has(key)) {
      return
    }
    const task = this.#loadChannel(key, { platform, channelId }).finally(() => {
      this.#pending.delete(key)
    })
    this.#pending.set(key, task)
  }

  /**
   * Forget a channel (its column was removed): drop its index, lists, and re-fetch scope,
   * stop its failure retries, unwatch its 7TV set, and rebuild the shared library so the
   * channel's emotes stop tokenizing in the remaining columns.
   */
  releaseChannel(platform: Platform, channelId: string): void {
    const key = `${platform}:${channelId}`
    this.#channelScopes.delete(key)
    this.#channelLists.delete(key)
    this.#clearRetry(key)
    this.#unbindSevenTvScope(key)
    if (this.#channels.delete(key)) {
      this.#rebuildShared()
    }
  }

  /** Fetch one channel scope and apply whatever succeeded; retries until every provider answers. */
  async #loadChannel(key: string, scope: { platform: Platform; channelId: string }): Promise<void> {
    const enabled = this.#providers()
    const load = await settleProviders(
      [
        enabled.ffz ? fetchFfzChannel(scope.platform, scope.channelId) : [],
        enabled.bttv ? fetchBttvChannel(scope.platform, scope.channelId) : [],
        enabled.sevenTv ? fetchSevenTvChannel(scope.platform, scope.channelId) : emptySevenTvSet()
      ],
      this.#channelLists.get(key)
    )
    if (this.#disposed || !this.#channelScopes.has(key)) {
      return // released while the fetch was in flight
    }
    this.#channelLists.set(key, load.lists)
    this.#channels.set(key, this.#indexLists(load.lists))
    this.#rebuildShared()
    this.#watchSevenTvSet(load.sevenTvSetId, key)
    this.#settleRetry(key, load.complete, () => this.#loadChannel(key, scope))
  }

  /** Load this account's own 7TV/BTTV/FFZ emotes (from its Twitch id) into the shared pool. */
  async loadUserEmotes(platform: Platform, channelId: string): Promise<void> {
    const scope = { platform, channelId }
    this.#userScope = scope
    await this.#loadUser(scope)
  }

  async #loadUser(scope: { platform: Platform; channelId: string }): Promise<void> {
    const enabled = this.#providers()
    const load = await settleProviders(
      [
        enabled.ffz ? fetchFfzChannel(scope.platform, scope.channelId) : [],
        enabled.bttv ? fetchBttvChannel(scope.platform, scope.channelId) : [],
        enabled.sevenTv ? fetchSevenTvChannel(scope.platform, scope.channelId) : emptySevenTvSet()
      ],
      this.#userLists
    )
    if (this.#disposed || this.#userScope !== scope) {
      return // logged out or switched identity while the fetch was in flight
    }
    this.#unbindSevenTvScope('user')
    this.#userLists = load.lists
    this.#userEmotes = this.#indexLists(load.lists)
    this.#rebuildShared()
    this.#watchSevenTvSet(load.sevenTvSetId, 'user')
    this.#settleRetry('user', load.complete, () => this.#loadUser(scope))
  }

  clearUserEmotes(): void {
    this.#unbindSevenTvScope('user')
    this.#clearRetry('user')
    this.#userScope = undefined
    this.#userLists = undefined
    this.#userEmotes = new Map()
    this.#rebuildShared()
  }

  /** After a load: a complete one ends the scope's retry cycle, an incomplete one (re)schedules. */
  #settleRetry(key: string, complete: boolean, run: () => Promise<void>): void {
    if (complete) {
      this.#clearRetry(key)
      return
    }
    if (this.#disposed || this.#retryTimers.has(key)) {
      return
    }
    const attempt = this.#retryAttempts.get(key) ?? 0
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 4))
    this.#retryAttempts.set(key, attempt + 1)
    this.#retryTimers.set(
      key,
      setTimeout(() => {
        this.#retryTimers.delete(key)
        void run()
      }, delay)
    )
  }

  #clearRetry(key: string): void {
    const timer = this.#retryTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    this.#retryTimers.delete(key)
    this.#retryAttempts.delete(key)
  }

  /**
   * Re-apply the emote-provider toggles at runtime: a disabled provider's emotes drop out of
   * every scope immediately (and the 7TV EventAPI socket stops when 7TV is off); re-enabled
   * providers are re-fetched for everything already loaded — globals, every ensured channel,
   * the account's own emotes — restarting the 7TV socket as its sets re-bind. Already-rendered
   * messages keep their emote fragments (they were tokenized at arrival); only future messages
   * reflect a toggle. Never rejects: a failed re-fetch leaves that scope's filtered emotes.
   */
  async applyProviderSettings(): Promise<void> {
    // Drop the watch registry and socket outright; the re-fetches below re-bind every set
    // that's still enabled onto a fresh client (a stopped SevenTvEvents is not restartable).
    this.#sevenTvScopes.clear()
    this.#sevenTvEvents?.stop()
    this.#sevenTvEvents = undefined
    // Cancel pending failure retries — the full re-fetch below re-schedules what still fails.
    this.#clearAllRetries()
    // Re-index what's already loaded so a disabled provider's emotes vanish immediately.
    if (this.#globalLists !== undefined) {
      this.#global = this.#indexLists(this.#globalLists)
    }
    for (const [key, lists] of this.#channelLists) {
      this.#channels.set(key, this.#indexLists(lists))
    }
    if (this.#userLists !== undefined) {
      this.#userEmotes = this.#indexLists(this.#userLists)
    }
    this.#rebuildShared()
    // Re-fetch every known scope so re-enabled providers come back (and 7TV sets re-bind).
    const tasks: Array<Promise<void>> = []
    if (this.#globalLists !== undefined) {
      tasks.push(
        this.loadGlobals().catch(() => {
          // Best-effort: keep the freshly filtered globals.
        })
      )
    }
    for (const [key, scope] of this.#channelScopes) {
      tasks.push(this.#loadChannel(key, scope))
    }
    const userScope = this.#userScope
    if (userScope !== undefined) {
      tasks.push(this.#loadUser(userScope))
    }
    await Promise.all(tasks)
  }

  /** Stop background work (the 7TV EventAPI socket, retries). Safe to call twice; not re-startable. */
  dispose(): void {
    this.#disposed = true
    this.#clearAllRetries()
    this.#sevenTvEvents?.stop()
    this.#sevenTvEvents = undefined
  }

  #clearAllRetries(): void {
    for (const timer of this.#retryTimers.values()) {
      clearTimeout(timer)
    }
    this.#retryTimers.clear()
    this.#retryAttempts.clear()
  }

  /** Bind a loaded 7TV set to a scope and lazily start the EventAPI client to watch it. */
  #watchSevenTvSet(setId: string | undefined, scope: string): void {
    // The providers guard covers loads that were in flight when 7TV was toggled off.
    if (setId === undefined || this.#disposed || !this.#providers().sevenTv) {
      return
    }
    let scopes = this.#sevenTvScopes.get(setId)
    if (scopes === undefined) {
      scopes = new Set()
      this.#sevenTvScopes.set(setId, scopes)
    }
    scopes.add(scope)
    this.#sevenTvEvents ??= new SevenTvEvents((id, change) => {
      this.#applySevenTvChange(id, change)
    }, this.#createSocket)
    this.#sevenTvEvents.watch(setId)
  }

  #unbindSevenTvScope(scope: string): void {
    for (const [setId, scopes] of this.#sevenTvScopes) {
      scopes.delete(scope)
      if (scopes.size === 0) {
        this.#sevenTvScopes.delete(setId)
        this.#sevenTvEvents?.unwatch(setId)
      }
    }
  }

  /** Apply a live EventAPI change to every scope backed by the set, re-indexing each. */
  #applySevenTvChange(setId: string, change: SevenTvSetChange): void {
    const scopes = this.#sevenTvScopes.get(setId)
    if (scopes === undefined) {
      return
    }
    let sharedDirty = false
    for (const scope of scopes) {
      if (scope === 'global' && this.#globalLists !== undefined) {
        mutateSevenTv(this.#globalLists, change)
        this.#global = this.#indexLists(this.#globalLists)
      } else if (scope === 'user' && this.#userLists !== undefined) {
        mutateSevenTv(this.#userLists, change)
        this.#userEmotes = this.#indexLists(this.#userLists)
        sharedDirty = true
      } else {
        const lists = this.#channelLists.get(scope)
        if (lists !== undefined) {
          mutateSevenTv(lists, change)
          this.#channels.set(scope, this.#indexLists(lists))
          sharedDirty = true
        }
      }
    }
    if (sharedDirty) {
      this.#rebuildShared()
    }
  }

  /** Rebuild the shared library = every added channel's third-party emotes + the user's own. */
  #rebuildShared(): void {
    const shared: EmoteIndex = new Map()
    for (const index of this.#channels.values()) {
      for (const [code, emote] of index) {
        shared.set(code, emote)
      }
    }
    for (const [code, emote] of this.#userEmotes) {
      shared.set(code, emote)
    }
    this.#shared = shared
  }

  /** Set the Twitch global + user emote catalog (Helix), or clear it on logout. */
  setTwitchGlobal(emotes: ResolvedEmote[]): void {
    this.#twitchGlobal = buildIndex([emotes])
  }

  /** Set a Twitch channel's native emotes (Helix), keyed by room id. */
  setTwitchChannel(roomId: string, emotes: ResolvedEmote[]): void {
    this.#twitchChannels.set(roomId, buildIndex([emotes]))
  }

  clearTwitch(): void {
    this.#twitchGlobal = new Map()
    this.#twitchChannels.clear()
  }

  /**
   * Set a YouTube channel's proprietary/member emojis (from its live-chat catalog) for the picker
   * and autocomplete. Not used for message tokenization — incoming YouTube emojis are already
   * imaged by the message parser, so these only power composing.
   */
  setYouTubeEmojis(channelId: string, emotes: ResolvedEmote[]): void {
    this.#youtubeEmojis.set(channelId, buildIndex([emotes]))
  }

  /**
   * All emotes in effect for a scope, tagged `channel` or `global`. A channel emote
   * shadows a global one with the same code (matching tokenize precedence), so each
   * code appears once.
   */
  list(scope?: { platform: Platform; channelId: string }): Array<ResolvedEmote & ScopeTag> {
    const out: Array<ResolvedEmote & ScopeTag> = []
    const seen = new Set<string>()
    const push = (index: EmoteIndex | undefined, tag: ScopeTag['scope']): void => {
      if (index === undefined) {
        return
      }
      for (const emote of index.values()) {
        if (!seen.has(emote.code)) {
          out.push({ ...emote, scope: tag })
          seen.add(emote.code)
        }
      }
    }
    const channelIndex =
      scope === undefined ? undefined : this.#channels.get(`${scope.platform}:${scope.channelId}`)
    const twitchChannelIndex =
      scope?.platform === 'twitch' ? this.#twitchChannels.get(scope.channelId) : undefined
    const youtubeEmojiIndex =
      scope?.platform === 'youtube' ? this.#youtubeEmojis.get(scope.channelId) : undefined
    push(channelIndex, 'channel')
    push(twitchChannelIndex, 'channel')
    push(youtubeEmojiIndex, 'channel')
    push(this.#shared, 'library')
    push(this.#global, 'global')
    push(this.#twitchGlobal, 'global')
    return out
  }

  tokenize(fragments: Fragment[], platform: Platform, channelId: string | undefined): Fragment[] {
    const channelIndex =
      channelId === undefined ? undefined : this.#channels.get(`${platform}:${channelId}`)
    const twitchChannelIndex =
      platform === 'twitch' && channelId !== undefined
        ? this.#twitchChannels.get(channelId)
        : undefined
    if (
      this.#global.size === 0 &&
      this.#shared.size === 0 &&
      this.#twitchGlobal.size === 0 &&
      channelIndex === undefined &&
      twitchChannelIndex === undefined
    ) {
      return fragments
    }
    const result: Fragment[] = []
    for (const fragment of fragments) {
      if (fragment.type === 'text' && fragment.verbatim !== true) {
        this.#tokenizeText(fragment.text, channelIndex, twitchChannelIndex, result)
      } else {
        result.push(fragment)
      }
    }
    return result
  }

  #lookup(
    code: string,
    channelIndex: EmoteIndex | undefined,
    twitchChannelIndex: EmoteIndex | undefined
  ): ResolvedEmote | undefined {
    return (
      channelIndex?.get(code) ??
      this.#shared.get(code) ??
      this.#global.get(code) ??
      twitchChannelIndex?.get(code) ??
      this.#twitchGlobal.get(code)
    )
  }

  #tokenizeText(
    text: string,
    channelIndex: EmoteIndex | undefined,
    twitchChannelIndex: EmoteIndex | undefined,
    out: Fragment[]
  ): void {
    let buffer = ''
    for (const piece of text.split(/(\s+)/)) {
      if (piece === '') {
        continue
      }
      const emote =
        piece.trim() === '' ? undefined : this.#lookup(piece, channelIndex, twitchChannelIndex)
      if (emote === undefined) {
        buffer += piece
        continue
      }
      if (buffer !== '') {
        out.push({ type: 'text', text: buffer })
        buffer = ''
      }
      out.push({
        type: 'emote',
        code: emote.code,
        url: emote.url,
        provider: emote.provider,
        zeroWidth: emote.zeroWidth,
        animated: emote.animated
      })
    }
    if (buffer !== '') {
      out.push({ type: 'text', text: buffer })
    }
  }
}
