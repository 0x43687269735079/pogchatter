import type { Innertube } from 'youtubei.js'
import type { ChatMessage, ClearTarget } from '@shared/model'
import { normalizeAction, unknownActionKeys, type RawAction } from '@main/sources/youtube/normalize'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 30_000
// Fallback poll interval when a continuation omits timeoutMs.
const DEFAULT_TIMEOUT_MS = 15_000
// Fast cadence used while a live chat is actively producing messages. YouTube's timeoutMs stays
// ~10s because it expects the real-time signaler push to fill the gap; when the push is healthy the
// reader is signal-driven and barely uses this, but when it isn't (no signaler, or the push falls
// behind) a busy chat is polled this fast and a quiet one backs off toward the server pace (see
// #nextInterval), so latency tracks how active the chat actually is.
const ACTIVE_POLL_MS = 1000
// Cap the quiet-chat backoff here instead of letting it climb to the ~10s server timeout, so a
// brief lull doesn't make the next message wait ~10s. Replay is still server-paced.
const LIVE_QUIET_CAP_MS = 4000
// Backstop interval while signal-driven: latency normally comes from the push, so the timer only
// has to cover a missed/dropped signal. Kept modest so a silently-stalled push (signaler connected
// but no longer pushing) is caught within this window instead of leaving chat to lag — and a
// backstop poll that finds messages then drops to fast polling until signals resume (#nextInterval).
const SAFETY_NET_MS = 8000
// Base interval for failure backoff — kept short so a transient blip recovers quickly.
const BACKOFF_BASE_MS = 5000
const STALL_THRESHOLD = 3
const MAX_BACKOFF_MS = 60_000
// A 200 with no readable live-chat continuation only means "stream ended" once it repeats — a
// transient hiccup or InnerTube shape drift must not end a column on a single response.
const END_CONFIRM_POLLS = 2
// Consecutive failures after which the continuation is presumed unusable: onBroken hands the owner
// the chance to re-bootstrap a fresh continuation instead of retrying this one forever.
const BROKEN_THRESHOLD = 10
// Sustained parse-degradation rule (designed not to flap): only action-bearing polls count. Enter
// degraded once DEGRADED_POLLS consecutive such polls each contain unknown actions AND unknowns are
// at least DEGRADED_UNKNOWN_SHARE of all actions across that streak — so neither a single mixed
// poll nor a low-rate trickle of one new type trips it. Exit after the same number of consecutive
// unknown-free action-bearing polls. Quiet polls (no actions) advance neither streak.
const DEGRADED_POLLS = 3
const DEGRADED_UNKNOWN_SHARE = 0.25
// Dev diagnostic (POGCHATTER_YT_SIGNALER_DEBUG): log the continuation mode and the Top→Live switch
// once, to tell whether the poll is in push-capable "invalidation" mode or plain timed polling.
const SIGNALER_DEBUG = process.env['POGCHATTER_YT_SIGNALER_DEBUG'] === '1'

interface ContinuationData {
  continuation?: string
  timeoutMs?: number
  invalidationId?: { topic?: string }
}
interface RawContinuation {
  invalidationContinuationData?: ContinuationData
  timedContinuationData?: ContinuationData
  reloadContinuationData?: ContinuationData
}
/** The Top chat / Live chat view selector that appears in the first get_live_chat response's header. */
interface RawSubMenuItem {
  selected?: boolean
  continuation?: { reloadContinuationData?: { continuation?: string } }
}
interface RawLiveChatContinuation {
  actions?: RawAction[]
  continuations?: RawContinuation[]
  header?: {
    liveChatHeaderRenderer?: {
      viewSelector?: { sortFilterSubMenuRenderer?: { subMenuItems?: RawSubMenuItem[] } }
    }
  }
}
interface RawLiveChatResponse {
  continuationContents?: { liveChatContinuation?: RawLiveChatContinuation }
}

export interface LiveChatHandlers {
  onMessages: (messages: ChatMessage[]) => void
  /** In-place message replacements (held → approved/hidden), keyed by message id. */
  onReplacements: (replacements: ChatMessage[]) => void
  onClears: (clears: ClearTarget[]) => void
  onEnd: () => void
  /** Fired once after several consecutive poll failures, so the source can surface an error. */
  onStall?: () => void
  /** Fired when polling recovers after a stall. */
  onResume?: () => void
  /**
   * Fired once after {@link BROKEN_THRESHOLD} consecutive poll failures: the continuation is
   * presumed unusable, and the owner should stop this reader and bootstrap a fresh one (via a new
   * getInfo). If the owner leaves the reader running, the capped backoff retries continue.
   */
  onBroken?: () => void
  /**
   * Fired on transitions of the sustained parse-degradation state (see {@link DEGRADED_POLLS}):
   * `true` once unknown actions persist across consecutive action-bearing polls at a meaningful
   * share, `false` once a comparable unknown-free stretch passes. Never re-fired while unchanged.
   */
  onDegraded?: (degraded: boolean) => void
}

/**
 * Polls the raw InnerTube `get_live_chat` endpoint (`parse: false`), bypassing
 * youtubei.js's `LiveChat` class, which mis-parses current responses (a stray
 * action type breaks its batch and leaves a `NaN` poll timeout). This reader
 * ignores unknown actions and never throws on one.
 *
 * Cadence adapts to activity: a live chat with messages every poll stays at {@link ACTIVE_POLL_MS};
 * an empty poll doubles the interval toward the server-provided `timeoutMs` (clamped, falling back
 * to {@link DEFAULT_TIMEOUT_MS}), and any message snaps it back to fast. Latency therefore tracks
 * how busy the chat is. Replay is always server-paced.
 *
 * When a {@link YouTubeSignaler} is attached (via {@link setSignalDriven}/{@link nudge}), the push
 * drives latency instead: each signal triggers an immediate poll and the timer relaxes to a slow
 * {@link SAFETY_NET_MS} backstop, falling back to adaptive polling if the signaler drops.
 */
export class LiveChatReader {
  readonly #actions: Innertube['actions']
  readonly #sourceId: string
  readonly #endpoint: string
  readonly #isReplay: boolean
  readonly #handlers: LiveChatHandlers
  #continuation: string | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #running = false
  #failures = 0
  /** Consecutive 200 responses with no readable continuation (see {@link END_CONFIRM_POLLS}). */
  #unreadable = 0
  /** Current adaptive live-poll interval: fast while active, doubled toward the server pace when quiet. */
  #interval = ACTIVE_POLL_MS
  /** A poll is in flight (so a nudge coalesces into one re-poll instead of stacking). */
  #polling = false
  /** A nudge arrived during an in-flight poll — re-poll immediately once it finishes. */
  #nudgeAgain = false
  /** A signaler is feeding nudges, so the timer is only a backstop. */
  #signalDriven = false
  /** This poll was triggered by a nudge (a real signal), not the backstop timer. */
  #nudged = false
  /** Signal-driven, but the backstop keeps finding messages the push never nudged for. */
  #pushBehind = false
  /** From a signal frame: forwarded to the next poll as `invalidationPayloadLastPublishAtUsec`. */
  #pendingPublishUsec: string | undefined
  /** Whether we've already switched from the default Top-chat continuation to Live chat. */
  #switchedToLive = false
  /** Diagnostic: whether the continuation mode has been logged for this reader yet. */
  #loggedMode = false
  /** Parse-health: actions whose type the normalizer recognized (even if they produced no output). */
  #knownActionCount = 0
  /** Parse-health: actions skipped because their top-level type keys are unrecognized. */
  #unknownActionCount = 0
  /** Unrecognized type keys already warned about, so each new key warns once per reader. */
  readonly #warnedUnknownTypes = new Set<string>()
  /** Degradation: consecutive action-bearing polls whose batch contained unknown actions. */
  #unhealthyPolls = 0
  /** Degradation: consecutive action-bearing polls with zero unknown actions. */
  #cleanPolls = 0
  /** Known/unknown action totals across the current unhealthy streak, for the share test. */
  #streakKnown = 0
  #streakUnknown = 0
  /** Currently degraded (onDegraded(true) fired; awaiting a clean stretch to fire `false`). */
  #degraded = false

  constructor(
    actions: Innertube['actions'],
    sourceId: string,
    continuation: string,
    isReplay: boolean,
    handlers: LiveChatHandlers
  ) {
    this.#actions = actions
    this.#sourceId = sourceId
    this.#continuation = continuation
    this.#isReplay = isReplay
    this.#endpoint = isReplay ? 'live_chat/get_live_chat_replay' : 'live_chat/get_live_chat'
    this.#handlers = handlers
  }

  /**
   * Begin reading. `initialResponse` is an optional pre-fetched snapshot (the `live_chat` page's
   * `ytInitialData`, shaped like a get_live_chat response) — it's dispatched through the same
   * handling as a poll, so the standing automod "held for review" queue it carries (which the POST
   * API omits) is surfaced before ongoing polling takes over from the continuation it advances to.
   */
  start(initialResponse?: unknown): void {
    if (this.#running || this.#continuation === undefined) {
      return
    }
    this.#running = true
    if (initialResponse !== undefined) {
      const delay = this.#handleResponse(initialResponse as RawLiveChatResponse, false)
      // A confirmed end (undefined) stops the reader; otherwise schedule polling from the
      // continuation the snapshot advanced us to (0 when it triggered the Top→Live switch).
      if (delay !== undefined) {
        this.#schedule(delay)
      }
      return
    }
    void this.#poll()
  }

  stop(): void {
    this.#running = false
    this.#polling = false
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /**
   * Poll immediately (coalescing): the signaler calls this the moment a real invalidation arrives.
   * `publishUsec` (the signal's publish timestamp) is forwarded to the next get_live_chat as
   * `invalidationPayloadLastPublishAtUsec`, matching the browser's signal→fetch request.
   */
  nudge(publishUsec: string | undefined): void {
    if (!this.#running || this.#continuation === undefined) {
      return
    }
    // Mark the next poll as signal-driven, so the backstop can tell a genuine push from a timer poll.
    this.#nudged = true
    if (publishUsec !== undefined) {
      this.#pendingPublishUsec = publishUsec
    }
    if (this.#polling) {
      this.#nudgeAgain = true
      return
    }
    // While polls are failing the backoff timer stays in charge — a signal must not defeat it.
    // The nudge's timestamp (stored above) still rides along on the eventual backoff poll.
    if (this.#failures > 0) {
      return
    }
    this.#schedule(0)
  }

  /**
   * Switch between signal-driven and self-paced polling. While signal-driven the timer is just a
   * slow backstop; turning it off resumes the fast adaptive cadence (e.g. if the signaler drops).
   */
  setSignalDriven(on: boolean): void {
    this.#signalDriven = on
    if (!on) {
      this.#interval = ACTIVE_POLL_MS
      this.#pushBehind = false
    }
  }

  async #poll(): Promise<void> {
    if (!this.#running || this.#continuation === undefined) {
      return
    }
    this.#polling = true
    const wasNudged = this.#nudged
    this.#nudged = false
    const publishUsec = this.#pendingPublishUsec
    this.#pendingPublishUsec = undefined
    let timeout = DEFAULT_TIMEOUT_MS
    try {
      // Match the browser's get_live_chat body: `webClientInfo` always, and (on a signal-driven
      // poll) the signal's publish timestamp so the server returns the freshly-published items.
      const payload: Record<string, unknown> = {
        continuation: this.#continuation,
        webClientInfo: { isDocumentHidden: true },
        parse: false
      }
      if (publishUsec !== undefined) {
        payload['invalidationPayloadLastPublishAtUsec'] = publishUsec
      }
      const response = await this.#actions.execute(this.#endpoint, payload)
      // stop() may have run while the request was in flight — don't dispatch or reschedule.
      if (!this.#running) {
        return
      }
      const delay = this.#handleResponse(response.data as RawLiveChatResponse, wasNudged)
      if (delay === undefined) {
        return
      }
      timeout = delay
    } catch {
      if (!this.#running) {
        return
      }
      // Transient network/parse failure — back off, and surface a stall after a few in a row.
      timeout = this.#registerFailure()
    }
    this.#polling = false
    if (!this.#running) {
      return
    }
    // A nudge that landed mid-poll re-polls immediately — unless failures are backing off.
    if (this.#nudgeAgain) {
      this.#nudgeAgain = false
      if (this.#failures === 0) {
        this.#schedule(0)
        return
      }
    }
    this.#schedule(timeout)
  }

  /**
   * Dispatch one 200 response; returns the next poll delay, or undefined once the reader stopped
   * (a confirmed stream end). A response with no readable continuation is first retried as an
   * ordinary poll failure — only a repeat confirms the end (see {@link END_CONFIRM_POLLS}).
   */
  #handleResponse(data: RawLiveChatResponse, wasNudged: boolean): number | undefined {
    const live = data.continuationContents?.liveChatContinuation
    if (live === undefined) {
      return this.#confirmEnd() ? undefined : this.#registerFailure()
    }
    // CUB-7: getInfo's continuation defaults to "Top chat" (filtered). Switch to "Live chat" (all
    // messages) once, from the first response's view selector, then re-poll from that continuation.
    const liveContinuation = this.#liveChatContinuation(live)
    if (liveContinuation !== undefined) {
      // This first ("Top chat") response is a snapshot: it already carries the chat's pending state,
      // including the automod "held for review" backlog a moderator sees on open. The "Live chat"
      // reload we switch to is not guaranteed to replay that backlog, so surface this snapshot's
      // actions before switching instead of discarding them. The renderer dedups by id, so any
      // overlap when the Live reload re-sends the same items is absorbed.
      const snapshot = live.actions ?? []
      this.#dispatch(snapshot)
      this.#unreadable = 0
      this.#switchedToLive = true
      this.#continuation = liveContinuation
      this.#logSwitch(snapshot.length)
      return 0
    }
    const hadMessages = this.#dispatch(live.actions ?? []) > 0
    const cont = live.continuations?.[0]
    this.#logMode(cont)
    const next =
      cont?.invalidationContinuationData ??
      cont?.timedContinuationData ??
      cont?.reloadContinuationData
    if (next?.continuation === undefined) {
      return this.#confirmEnd() ? undefined : this.#registerFailure()
    }
    this.#unreadable = 0
    this.#continuation = next.continuation
    if (this.#failures > 0) {
      this.#failures = 0
      this.#handlers.onResume?.()
    }
    return this.#nextInterval(next.timeoutMs, hadMessages, wasNudged)
  }

  /**
   * One more 200 the reader can't read; returns true once the streak confirms the stream really
   * ended (onEnd fired, reader stopped). The streak only resets on a readable continuation, so a
   * thrown poll in between doesn't break it.
   */
  #confirmEnd(): boolean {
    this.#unreadable += 1
    if (this.#unreadable >= END_CONFIRM_POLLS) {
      this.#handlers.onEnd()
      this.stop()
      return true
    }
    return false
  }

  /** Count one poll failure: fires onStall/onBroken at their thresholds, returns the backoff delay. */
  #registerFailure(): number {
    this.#failures += 1
    if (this.#failures === STALL_THRESHOLD) {
      this.#handlers.onStall?.()
    }
    if (this.#failures === BROKEN_THRESHOLD) {
      this.#handlers.onBroken?.()
    }
    return this.#backoff()
  }

  #schedule(delay: number): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
    }
    this.#timer = setTimeout(() => {
      void this.#poll()
    }, delay)
  }

  /** Dev diagnostic: log the continuation mode + invalidation topic once (signaler investigation). */
  #logMode(cont: RawContinuation | undefined): void {
    if (!SIGNALER_DEBUG || this.#loggedMode || cont === undefined) {
      return
    }
    this.#loggedMode = true
    const mode = cont.invalidationContinuationData
      ? 'invalidation'
      : cont.timedContinuationData
        ? 'timed'
        : cont.reloadContinuationData
          ? 'reload'
          : 'unknown'
    const topic = cont.invalidationContinuationData?.invalidationId?.topic ?? '(none)'
    const time = new Date().toISOString().slice(11, 23)
    process.stdout.write(
      `[${time}] [reader] ${this.#sourceId}: continuation=${mode} topic=${topic}\n`
    )
  }

  /**
   * Next poll delay. Replay is always server-paced. A live chat snaps to {@link ACTIVE_POLL_MS}
   * on any message and otherwise doubles its interval toward the (clamped) server `timeoutMs`, so
   * latency tracks how active the chat is without hammering a quiet one.
   */
  #nextInterval(
    serverTimeoutMs: number | undefined,
    hadMessages: boolean,
    wasNudged: boolean
  ): number {
    const server =
      typeof serverTimeoutMs === 'number' && Number.isFinite(serverTimeoutMs)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, serverTimeoutMs))
        : DEFAULT_TIMEOUT_MS
    if (this.#isReplay) {
      return server
    }
    if (this.#signalDriven) {
      // Push normally drives latency, so hold the long backstop. But a backstop poll (no preceding
      // nudge) that turns up messages means the push missed them — poll fast until a nudge proves
      // the push is delivering again, so a silently-stalled signaler can't leave chat lagging.
      if (wasNudged) {
        this.#setPushBehind(false)
      } else if (hadMessages) {
        this.#setPushBehind(true)
      }
      return this.#pushBehind ? ACTIVE_POLL_MS : SAFETY_NET_MS
    }
    // Cap the quiet backoff well below the server timeout so a brief lull stays responsive.
    const quietCap = Math.min(server, LIVE_QUIET_CAP_MS)
    this.#interval = hadMessages ? ACTIVE_POLL_MS : Math.min(quietCap, this.#interval * 2)
    return this.#interval
  }

  /** Track (and, in debug, log) whether the push has fallen behind so the backstop is doing the work. */
  #setPushBehind(behind: boolean): void {
    if (behind === this.#pushBehind) {
      return
    }
    this.#pushBehind = behind
    if (SIGNALER_DEBUG) {
      const time = new Date().toISOString().slice(11, 23)
      const msg = behind
        ? 'push fell behind (backstop found messages) — polling fast until signals resume'
        : 'push caught up — back to the signal backstop'
      process.stdout.write(`[${time}] [reader] ${this.#sourceId}: ${msg}\n`)
    }
  }

  /**
   * The "Live chat" continuation to switch to, or undefined. getInfo's continuation defaults to the
   * "Top chat" view (item 0, selected, message-filtered); the second view-selector item is the
   * unfiltered "Live chat". Switch once, only while still on the selected-Top default.
   */
  #liveChatContinuation(live: RawLiveChatContinuation): string | undefined {
    if (this.#isReplay || this.#switchedToLive) {
      return undefined
    }
    const items =
      live.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems
    if (!Array.isArray(items) || items.length < 2 || items[0]?.selected !== true) {
      return undefined
    }
    return items[1]?.continuation?.reloadContinuationData?.continuation
  }

  #logSwitch(snapshotActions: number): void {
    if (!SIGNALER_DEBUG) {
      return
    }
    const time = new Date().toISOString().slice(11, 23)
    process.stdout.write(
      `[${time}] [reader] ${this.#sourceId}: switched Top chat → Live chat (surfaced ${snapshotActions} snapshot actions)\n`
    )
  }

  /** Exponential backoff with jitter, capped, for repeated poll failures. */
  #backoff(): number {
    const ceiling = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#failures, 6))
    return ceiling / 2 + Math.random() * (ceiling / 2)
  }

  /** Normalize and emit the batch; returns the number of chat messages produced. */
  #dispatch(actions: RawAction[]): number {
    const messages: ChatMessage[] = []
    const replacements: ChatMessage[] = []
    const clears: ClearTarget[] = []
    const newUnknownTypes: string[] = []
    let batchKnown = 0
    let batchUnknown = 0
    for (const action of actions) {
      if (this.#trackParseHealth(action, newUnknownTypes)) {
        batchKnown += 1
      } else {
        batchUnknown += 1
      }
      const result = normalizeAction(this.#sourceId, action)
      messages.push(...result.messages)
      replacements.push(...result.replacements)
      clears.push(...result.clears)
    }
    this.#warnUnknownTypes(newUnknownTypes)
    this.#trackDegradation(batchKnown, batchUnknown)
    if (messages.length > 0) {
      this.#handlers.onMessages(messages)
    }
    if (replacements.length > 0) {
      this.#handlers.onReplacements(replacements)
    }
    if (clears.length > 0) {
      this.#handlers.onClears(clears)
    }
    return messages.length
  }

  /**
   * Counts this action as known or unknown (returning whether it was known); collects type keys
   * not yet warned about into `newTypes`.
   */
  #trackParseHealth(action: RawAction, newTypes: string[]): boolean {
    const unknown = unknownActionKeys(action)
    if (unknown.length === 0) {
      this.#knownActionCount += 1
      return true
    }
    this.#unknownActionCount += 1
    for (const key of unknown) {
      if (!this.#warnedUnknownTypes.has(key)) {
        this.#warnedUnknownTypes.add(key)
        newTypes.push(key)
      }
    }
    return false
  }

  /**
   * Sustained-degradation detector over the most recent action-bearing polls (the rule lives at
   * {@link DEGRADED_POLLS}/{@link DEGRADED_UNKNOWN_SHARE}). Plain counters — an unknown-free poll
   * resets the unhealthy streak and vice versa, and {@link LiveChatHandlers.onDegraded} fires only
   * when the state actually flips.
   */
  #trackDegradation(known: number, unknown: number): void {
    if (known + unknown === 0) {
      return
    }
    if (unknown === 0) {
      this.#unhealthyPolls = 0
      this.#streakKnown = 0
      this.#streakUnknown = 0
      this.#cleanPolls += 1
      if (this.#degraded && this.#cleanPolls >= DEGRADED_POLLS) {
        this.#degraded = false
        this.#handlers.onDegraded?.(false)
      }
      return
    }
    this.#cleanPolls = 0
    this.#unhealthyPolls += 1
    this.#streakKnown += known
    this.#streakUnknown += unknown
    const share = this.#streakUnknown / (this.#streakKnown + this.#streakUnknown)
    if (
      !this.#degraded &&
      this.#unhealthyPolls >= DEGRADED_POLLS &&
      share >= DEGRADED_UNKNOWN_SHARE
    ) {
      this.#degraded = true
      this.#handlers.onDegraded?.(true)
    }
  }

  /**
   * Parse-health tripwire: one structured warning per reader per distinct new action/renderer type
   * key — never per message, and type-key names only (no content) — so a report of degraded chat
   * names the drifted shape. The unknown actions themselves are still skipped silently.
   */
  #warnUnknownTypes(newTypes: string[]): void {
    if (newTypes.length === 0) {
      return
    }
    console.warn(`[youtube] ${this.#sourceId}: unrecognized live-chat action types`, {
      newTypes,
      knownActions: this.#knownActionCount,
      unknownActions: this.#unknownActionCount
    })
  }
}
