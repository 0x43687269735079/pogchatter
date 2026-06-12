import {
  backChannelUrl,
  bindBody,
  bindUrl,
  chooseServerBody,
  chooseServerUrl,
  classifyFrame,
  parseFrames,
  parseGsessionId,
  parseSid,
  topicFor
} from '@main/sources/youtube/signalerProtocol'

const ORIGIN = 'https://www.youtube.com'
const RECONNECT_BASE_MS = 2000
const MAX_RECONNECT_MS = 30_000
// Floor between back-channel polls that return nothing, so a misbehaving channel can't hot-loop.
const EMPTY_CYCLE_DELAY_MS = 500
// Abort a back-channel poll that runs past this — the server holds it ~30s, so longer is a hang.
const CYCLE_TIMEOUT_MS = 40_000
// After a batch arrives, an idle gap this long means the batch is done — re-issue with the new AID.
const BATCH_IDLE_MS = 500
// Sentinel for the idle branch of the back-channel read race.
const IDLE = Symbol('idle')

interface ConsumeStats {
  frames: number
  /** Real topic-invalidation signals (excludes open/ack/noop). */
  signals: number
  /** First bytes of the response, kept so an empty/error cycle can be diagnosed. */
  sample: string
}

export interface SignalerHandlers {
  /**
   * A real topic invalidation arrived — fetch the chat now. `publishUsec` is the frame's first
   * publish timestamp, forwarded to get_live_chat as `invalidationPayloadLastPublishAtUsec` (the
   * browser does this). Only fires for genuine signals, never for open/ack/noop frames.
   */
  onSignal: (publishUsec: string | undefined) => void
  /** The push channel opened. */
  onConnect?: () => void
  /** The push channel dropped (fall back to polling until it reconnects). */
  onDisconnect?: () => void
}

/**
 * Drives YouTube's live-chat "signaler" — Google's WebChannel/BrowserChannel push that fires when a
 * chat changes (protocol in {@link signalerProtocol}, reverse-engineered from browser captures). It carries no message
 * content, only "go fetch", so it nudges the poller rather than replacing it. Anonymous (no
 * cookies/auth), self-reconnecting, and best-effort: any failure just leaves the poller in charge.
 */
export class YouTubeSignaler {
  readonly #fetch: typeof fetch
  readonly #topic: string
  readonly #handlers: SignalerHandlers
  readonly #log: (message: string) => void
  #running = false
  #abort: AbortController | undefined
  #failures = 0

  constructor(
    fetchFn: typeof fetch,
    videoId: string,
    handlers: SignalerHandlers,
    log: (message: string) => void = () => {}
  ) {
    this.#fetch = fetchFn
    this.#topic = topicFor(videoId)
    this.#handlers = handlers
    this.#log = log
  }

  start(): void {
    if (this.#running) {
      return
    }
    this.#running = true
    void this.#run()
  }

  stop(): void {
    this.#running = false
    this.#abort?.abort()
    this.#abort = undefined
  }

  /** Reconnect loop: each session negotiates and then long-polls until it drops. */
  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.#session()
      } catch (error) {
        if (!this.#running) {
          return
        }
        // onDisconnect already fired in #session's finally once a session had connected.
        this.#failures += 1
        this.#log(`signaler dropped (${errorMessage(error)}) — reconnecting`)
        await this.#delay(this.#backoff())
      }
    }
  }

  async #session(): Promise<void> {
    // One controller for the whole session, assigned before the handshake: stop() must be able
    // to abort an in-flight chooseServer/bind POST too, not only the back-channel long-poll —
    // otherwise a black-holed handshake outlives the source teardown for minutes.
    const abort = new AbortController()
    this.#abort = abort
    const gsessionid = await this.#chooseServer(abort.signal)
    const sid = await this.#openChannel(abort.signal, gsessionid)
    this.#log('signaler connected')
    // The channel is established — reconnect backoff starts fresh from here, so routine drops
    // over a long stream don't accumulate into a permanently maxed-out backoff.
    this.#failures = 0
    this.#handlers.onConnect?.()
    try {
      await this.#backChannel(gsessionid, sid)
    } finally {
      this.#handlers.onDisconnect?.()
    }
  }

  async #chooseServer(signal: AbortSignal): Promise<string> {
    const response = await this.#post(
      chooseServerUrl(),
      chooseServerBody(this.#topic),
      'application/json+protobuf',
      signal
    )
    const gsessionid = parseGsessionId(await response.text())
    if (gsessionid === undefined) {
      throw new Error(`chooseServer ${response.status}`)
    }
    return gsessionid
  }

  async #openChannel(signal: AbortSignal, gsessionid: string): Promise<string> {
    const response = await this.#post(
      bindUrl(gsessionid, randomRid(), randomZx()),
      bindBody(this.#topic),
      'application/x-www-form-urlencoded',
      signal,
      { 'X-WebChannel-Content-Type': 'application/json+protobuf' }
    )
    const sid = parseSid(await response.text())
    if (sid === undefined) {
      throw new Error(`open channel ${response.status}`)
    }
    return sid
  }

  /** Long-poll the back channel, re-issuing with the latest AID until it errors or we stop. */
  async #backChannel(gsessionid: string, sid: string): Promise<void> {
    let aid = 0
    let ci = 0
    while (this.#running) {
      const abort = new AbortController()
      this.#abort = abort
      // Bound the cycle: the server holds the long-poll ~30s, so anything past that is a hung
      // connection — abort it and reconnect rather than stall (and the reader's backstop covers it).
      const guard = setTimeout(() => abort.abort(), CYCLE_TIMEOUT_MS)
      unref(guard)
      const startedAt = Date.now()
      const stats: ConsumeStats = { frames: 0, signals: 0, sample: '' }
      try {
        const response = await this.#fetch(backChannelUrl(gsessionid, sid, aid, ci, randomZx()), {
          method: 'GET',
          headers: this.#headers(),
          signal: abort.signal
        })
        if (!response.ok || response.body === null) {
          throw new Error(`back channel ${response.status}`)
        }
        aid = await this.#consume(response.body, aid, stats)
        ci = 1
      } finally {
        clearTimeout(guard)
        this.#logCycle(stats, aid, Date.now() - startedAt)
      }
      if (stats.frames === 0 && this.#running) {
        // A healthy long-poll holds ~30s; an instantly-empty response would otherwise hot-loop.
        await this.#delay(EMPTY_CYCLE_DELAY_MS)
      }
    }
  }

  /**
   * Read one back-channel batch, firing onSignal per signal frame; mutates `stats`, returns AID.
   *
   * The server sends a batch then keeps the connection open waiting for us to re-issue with the new
   * AID (the AID acks receipt) — and undici doesn't surface the close over h2 — so holding the
   * stream would stall. Once a batch has arrived, an idle gap means "batch done": stop reading and
   * return so the caller re-issues. Before the first frame we hold the long-poll (bounded by the
   * cycle guard) so a quiet chat doesn't busy-reissue.
   */
  async #consume(
    body: ReadableStream<Uint8Array>,
    startAid: number,
    stats: ConsumeStats
  ): Promise<number> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let aid = startAid
    while (this.#running) {
      const next =
        stats.frames > 0
          ? await Promise.race([reader.read(), idleAfter(BATCH_IDLE_MS)])
          : await reader.read()
      if (next === IDLE) {
        await reader.cancel().catch(() => {})
        break
      }
      if (next.done) {
        break
      }
      buffer += decoder.decode(next.value, { stream: true })
      if (stats.sample === '') {
        // First bytes, for diagnosing a non-streaming / mis-decoded (e.g. still-compressed) body.
        stats.sample = buffer.slice(0, 120)
      }
      const parsed = parseFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        stats.frames += 1
        aid = Math.max(aid, frame.id)
        const info = classifyFrame(frame)
        if (info.kind === 'signal') {
          stats.signals += 1
          this.#handlers.onSignal(info.publishUsec)
        }
      }
    }
    return aid
  }

  /**
   * Log a back-channel cycle, but only when it's noteworthy: a cycle that delivered real signals,
   * or one that returned nothing (an error/empty body — e.g. a rejected subscription — worth its
   * first bytes for diagnosis). Idle noop-keepalive cycles are silent.
   */
  #logCycle(stats: ConsumeStats, aid: number, ms: number): void {
    if (stats.signals > 0) {
      this.#log(`signal ×${stats.signals} (aid→${aid}, ${ms}ms)`)
    } else if (stats.frames === 0) {
      this.#log(`back-channel empty (${ms}ms); sample=${JSON.stringify(stats.sample)}`)
    }
  }

  #post(
    url: string,
    body: string,
    contentType: string,
    signal: AbortSignal,
    extra: Record<string, string> = {}
  ): Promise<Response> {
    return this.#fetch(url, {
      method: 'POST',
      headers: { ...this.#headers(), 'Content-Type': contentType, ...extra },
      body,
      signal
    })
  }

  #headers(): Record<string, string> {
    return {
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      // Force an uncompressed response: the back channel is read as a byte stream, and a gzip/br
      // body would parse as garbage (and produce no signals) if it reaches us still compressed.
      'Accept-Encoding': 'identity'
    }
  }

  #backoff(): number {
    return Math.min(MAX_RECONNECT_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.#failures, 4))
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      unref(setTimeout(resolve, ms))
    })
  }
}

/** Keep a timer from holding the process open (no-op where unref isn't available). */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

/** Resolve to the {@link IDLE} sentinel after `ms`, for racing against a back-channel read. */
function idleAfter(ms: number): Promise<typeof IDLE> {
  return new Promise((resolve) => {
    unref(setTimeout(() => resolve(IDLE), ms))
  })
}

function randomRid(): number {
  return 10_000 + Math.floor(Math.random() * 90_000)
}

function randomZx(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
