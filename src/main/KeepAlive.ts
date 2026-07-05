/**
 * Fast recovery across OS sleep/suspend/resume. When a laptop wakes, both chat connectors' sockets are
 * half-open and silently dead (no RST; default TCP keepalive is ~2h while NAT idle timeouts are ~1min),
 * so nothing errors and the app "freezes then slowly recovers" as it waits on timeouts. This detects the
 * wake two ways — the OS `resume` event, and a wall-clock watchdog for when that event doesn't fire
 * (Linux packaged builds, macOS App Nap) — and reconnects everything immediately.
 *
 * All timing/OS/network access is injected so the policy is testable without power or network hardware.
 * The watchdog MUST compare wall-clock (`Date.now`) deltas: monotonic clocks freeze across suspend on
 * Linux and would miss the gap entirely.
 */

/** How often the wall-clock watchdog samples the clock. */
const TICK_MS = 20_000
/** A between-ticks gap this much larger than {@link TICK_MS} means the process was frozen (slept/napped). */
const GAP_MS = 90_000
/** How often to re-check the network while waiting for it to come back after a wake. */
const ONLINE_POLL_MS = 2_000
/** Give up waiting for the network and just attempt the reconnect after this long. */
const ONLINE_WAIT_CAP_MS = 90_000

export interface KeepAliveDeps {
  /** Reconnect every chat source (disconnect + connect); best-effort, isolates per-source failures. */
  reconnectAll: () => Promise<void>
  /** Whether the OS reports a network connection — a hint only; `true` may still be a dead network. */
  isOnline: () => boolean
  /** Current wall-clock time in ms (`Date.now` in production — required, not a monotonic clock). */
  now: () => number
  /** Resolve after `ms` (a real timer in production; controllable in tests). */
  wait: (ms: number) => Promise<void>
  /** Subscribe to an OS power event (`powerMonitor.on` in production). */
  onPower: (event: 'suspend' | 'resume', handler: () => void) => void
  /** Emit a diagnostic line (routed to `--debug-log` in production; metadata only). */
  log: (message: string, data?: Record<string, unknown>) => void
}

export class KeepAlive {
  readonly #deps: KeepAliveDeps
  #tickTimer: ReturnType<typeof setInterval> | undefined
  #lastTick = 0
  #reconnecting = false
  #again = false
  #stopped = false

  constructor(deps: KeepAliveDeps) {
    this.#deps = deps
  }

  /** Wire the OS power events and start the wall-clock watchdog. */
  start(): void {
    this.#lastTick = this.#deps.now()
    this.#deps.onPower('suspend', () => {
      // Nothing to do but note it and reset the clock baseline — the paired `resume` (or, if that
      // doesn't fire, the watchdog's gap) drives the reconnect. We don't disconnect here: the reconnect
      // discards the dead sockets, and disconnecting on a spurious suspend could strand the columns.
      this.#lastTick = this.#deps.now()
      this.#deps.log('suspend')
    })
    this.#deps.onPower('resume', () => {
      // Reset the watchdog baseline like suspend does, so the post-wake tick doesn't also see a huge
      // gap and fire a second, redundant reconnect on top of this one.
      this.#lastTick = this.#deps.now()
      this.#deps.log('resume')
      void this.reconnectNow('resume')
    })
    const timer = setInterval(() => this.checkGap(), TICK_MS)
    timer.unref()
    this.#tickTimer = timer
  }

  stop(): void {
    this.#stopped = true
    if (this.#tickTimer !== undefined) {
      clearInterval(this.#tickTimer)
      this.#tickTimer = undefined
    }
  }

  /** One watchdog sample: a wall-clock gap far larger than the tick means we slept/napped — reconnect. */
  checkGap(): void {
    const now = this.#deps.now()
    const gap = now - this.#lastTick
    this.#lastTick = now
    if (gap > GAP_MS) {
      this.#deps.log('sleep gap detected', { gapMs: gap })
      void this.reconnectNow('gap')
    }
  }

  /**
   * Reconnect everything, coalescing overlapping triggers (`resume`, the watchdog, a repeat) into a
   * single in-flight attempt that re-runs once if another trigger arrived meanwhile. Waits for the
   * network to report online first (bounded). Best-effort: a thrown reconnect is logged, never wedges.
   */
  async reconnectNow(reason: string): Promise<void> {
    if (this.#reconnecting) {
      this.#again = true
      return
    }
    this.#reconnecting = true
    try {
      do {
        this.#again = false
        await this.#waitForOnline()
        if (this.#stopped) {
          return
        }
        this.#deps.log('reconnecting', { reason })
        await this.#deps.reconnectAll()
        this.#deps.log('reconnected', { reason })
      } while (this.#again && !this.#stopped)
    } catch (error) {
      this.#deps.log('reconnect failed', { reason, error: String(error) })
    } finally {
      this.#reconnecting = false
    }
  }

  /** Resolve once the OS reports online, or after {@link ONLINE_WAIT_CAP_MS} — Linux is often unusable
   *  ~10–60s after resume, and attempting a connect into a down network just burns a retry. */
  async #waitForOnline(): Promise<void> {
    const deadline = this.#deps.now() + ONLINE_WAIT_CAP_MS
    while (!this.#deps.isOnline() && this.#deps.now() < deadline && !this.#stopped) {
      await this.#deps.wait(ONLINE_POLL_MS)
    }
  }
}
