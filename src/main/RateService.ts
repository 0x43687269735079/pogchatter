import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RateTable } from '@shared/donations'
import { proxiedFetch } from '@main/net/proxy'

/** Rates are daily figures at both providers, so asking more often only adds traffic. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/**
 * Floor between coverage-recovery fetches. Separate from the daily refresh: this one is triggered by
 * a donation in an uncovered currency, so it must not let an unlucky stream become a request stream.
 */
const RECOVERY_INTERVAL_MS = 60 * 60 * 1000
/** A rate fetch is never worth making anyone wait; it is background work with a hard ceiling. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Tried in order, stopping at the first that answers — so the ordinary day costs exactly one request.
 *
 * ExchangeRate-API leads on *coverage*, which turned out to matter far more than it first appeared.
 * Frankfurter serves the ECB reference basket — 30 currencies — while YouTube takes Super Chats in
 * about seventy. Forty of those, the Costa Rican colón among them, simply are not in Frankfurter,
 * and a failure-triggered fallback never rescues them: Frankfurter does not fail, it returns a
 * perfectly valid table with no colón in it, so those donations would be written off as unrecognised
 * currencies forever. ExchangeRate-API carries all of them.
 *
 * Frankfurter stays as the fallback: keyless, uncapped, open source and self-hostable, so a bad day
 * at the primary still leaves the major currencies converting.
 *
 * Attribution: ExchangeRate-API asks for credit when its open endpoint is used; the panel names
 * whichever provider supplied the rates it is showing. One request a day sits far inside its
 * fair-use limit.
 */
const PROVIDERS: ReadonlyArray<{
  name: string
  url: (base: string) => string
  parse: (body: unknown) => Record<string, number> | undefined
}> = [
  {
    name: 'ExchangeRate-API',
    url: (base) => `https://open.er-api.com/v6/latest/${base}`,
    parse: (body) => ratesOf((body as { rates?: unknown }).rates)
  },
  {
    name: 'Frankfurter',
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${base}`,
    parse: (body) => ratesOf((body as { rates?: unknown }).rates)
  }
]

export interface RateServiceDeps {
  dir: string
  fetchFn?: typeof fetch
  now?: () => number
  /**
   * Called whenever the table or source changes (a fetch committed, or a failed refresh marked the
   * cache stale). Lets the owner push the new rates to the renderer, so a coverage-recovery fetch or a
   * provider switch reaches an open panel instead of waiting for a reload.
   */
  onChange?: () => void
}

/**
 * Exchange rates for the donations panel: fetched at most daily, cached on disk, and degraded rather
 * than failed.
 *
 * The ladder is fresh cache → primary → fallback → stale cache → nothing, and every rung still lets
 * the panel show what the platform originally sent. Nothing awaits a refresh, so a slow or missing
 * network never delays startup, chat, or a donation appearing.
 */
export class RateService {
  readonly #path: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #onChange: (() => void) | undefined
  #table: RateTable | undefined
  /** Provider that supplied the current table, for the attribution line. */
  #source: string | undefined
  /** In-flight fetches keyed by base, so a second request for the same base joins the first. */
  readonly #inFlight = new Map<string, Promise<void>>()
  /**
   * Bumped on every new fetch intent. A fetch commits its result only if its generation is still the
   * latest, so an older base's slow response can never overwrite a newer base the user just chose.
   */
  #generation = 0
  /** When a coverage-recovery fetch was last attempted; undefined means never (see recoverMissing). */
  #lastRecovery: number | undefined

  constructor(deps: RateServiceDeps) {
    this.#path = join(deps.dir, 'rates.json')
    this.#fetch = deps.fetchFn ?? proxiedFetch
    this.#now = deps.now ?? Date.now
    this.#onChange = deps.onChange
    this.#load()
  }

  /** The current rates, or `undefined` if none have ever been fetched. */
  table(): RateTable | undefined {
    return this.#table
  }

  source(): string | undefined {
    return this.#source
  }

  /**
   * Bring rates for `base` up to date. Resolves when done and **never rejects** — callers treat it as
   * fire-and-forget. A cache that is fresh and already for `base` short-circuits, so repeated startups
   * make no request.
   */
  async refresh(base: string): Promise<void> {
    const wanted = base.toUpperCase()
    // A fetch already running for this base answers the same question — join it rather than duplicate.
    // A fetch for a *different* base is left alone, so the newly-chosen base is still fetched.
    const existing = this.#inFlight.get(wanted)
    if (existing !== undefined) {
      return existing
    }
    const current = this.#table
    if (
      current !== undefined &&
      current.base === wanted &&
      // `0` means the cache carried no usable timestamp, so its age is unknown and cannot vouch for
      // it — relying on `now() - 0` being large would make this depend on the clock's magnitude.
      current.fetchedAt > 0 &&
      this.#now() - current.fetchedAt < MAX_AGE_MS
    ) {
      return
    }
    return this.#start(wanted)
  }

  /** Begin (and track) a fetch for `base`; concurrent callers share it, and only the latest commits. */
  #start(base: string): Promise<void> {
    const generation = ++this.#generation
    const inFlight = this.#fetchFrom(base, generation).finally(() => {
      this.#inFlight.delete(base)
    })
    this.#inFlight.set(base, inFlight)
    return inFlight
  }

  /**
   * A donation arrived in a currency the cached table doesn't cover — try again, if there is reason
   * to think trying would help.
   *
   * A table from the widest provider that is still fresh has already answered this question: the
   * currency genuinely isn't offered, and asking again would only spend requests. It is worth a
   * retry when we are running on the narrow fallback, have nothing at all, or are serving something
   * stale. Bounded to {@link RECOVERY_INTERVAL_MS} so a stream full of an uncovered currency cannot
   * turn into a stream of requests. Fire-and-forget; never rejects.
   */
  recoverMissing(base: string, currency: string): void {
    const wanted = base.toUpperCase()
    const code = currency.toUpperCase()
    // The base itself never needs a rate — a same-currency donation converts directly (see convert).
    if (code === wanted) {
      return
    }
    const table = this.#table
    // Only a table fetched for *this* base can say whether the currency is covered; one left over from
    // a previous base is about a different question, so its coverage must not short-circuit recovery.
    if (table !== undefined && table.base === wanted && table.rates[code] !== undefined) {
      return
    }
    const onWidestAndFresh =
      table !== undefined &&
      table.base === wanted &&
      !table.stale &&
      this.#source === PROVIDERS[0]?.name
    if (onWidestAndFresh) {
      return
    }
    // Explicitly "never" rather than a zero sentinel: `now() - 0` is only large when the clock is,
    // which would make the first recovery depend on the epoch rather than on having not run yet.
    const now = this.#now()
    const last = this.#lastRecovery
    if (last !== undefined && now - last < RECOVERY_INTERVAL_MS) {
      return
    }
    // A refresh for this base is already running and will deliver a table — don't duplicate the traffic.
    if (this.#inFlight.has(wanted)) {
      return
    }
    this.#lastRecovery = now
    // Past the freshness check deliberately: the cache is not the problem, its coverage is.
    void this.#start(wanted)
  }

  async #fetchFrom(base: string, generation: number): Promise<void> {
    for (const provider of PROVIDERS) {
      const rates = await this.#tryProvider(provider, base)
      if (rates !== undefined) {
        // A newer intent (a base change, say) started while this was in flight — its result is the one
        // that should stand, so drop this now-stale one rather than overwrite the newer base.
        if (generation !== this.#generation) {
          return
        }
        this.#table = { base, rates, fetchedAt: this.#now(), stale: false }
        this.#source = provider.name
        this.#persist()
        this.#notify()
        return
      }
    }
    // Both providers failed. Keep serving what we have, but say that it is old rather than passing
    // yesterday's figures off as today's — unless a newer intent has already superseded this base.
    if (generation === this.#generation && this.#table !== undefined) {
      this.#table = { ...this.#table, stale: true }
      this.#notify()
    }
  }

  #notify(): void {
    this.#onChange?.()
  }

  async #tryProvider(
    provider: (typeof PROVIDERS)[number],
    base: string
  ): Promise<Record<string, number> | undefined> {
    try {
      const response = await this.#fetch(provider.url(base), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        return undefined
      }
      // Validate before it can replace a good cache: a malformed body is a failure, not new data.
      return provider.parse(await response.json())
    } catch {
      return undefined
    }
  }

  #persist(): void {
    try {
      const body = JSON.stringify({ table: this.#table, source: this.#source })
      writeFileSync(`${this.#path}.tmp`, body)
      renameSync(`${this.#path}.tmp`, this.#path)
    } catch {
      // The cache is an optimisation; failing to write it costs one request next launch.
    }
  }

  #load(): void {
    try {
      if (!existsSync(this.#path)) {
        return
      }
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      const table = (parsed as { table?: unknown }).table as RateTable | undefined
      const rates = ratesOf(table?.rates)
      if (table === undefined || rates === undefined || typeof table.base !== 'string') {
        return
      }
      // A timestamp from a user-writable file is not evidence: `JSON.parse` turns `1e999` into
      // `Infinity`, which `typeof number` accepts, and the freshness test would then be permanently
      // satisfied — suppressing every future refresh for the life of the install. Anything not a
      // finite past time is treated as never-fetched, which forces a refresh rather than trusting it.
      const claimed = table.fetchedAt
      const fetchedAt =
        typeof claimed === 'number' && Number.isFinite(claimed) && claimed <= this.#now()
          ? claimed
          : 0
      this.#table = {
        base: table.base.toUpperCase(),
        rates,
        fetchedAt,
        // Stale is a statement about age, not about provenance: asserting it unconditionally meant a
        // cache written minutes ago was reported as unrefreshable, because `refresh` short-circuits
        // while it is fresh and so never cleared the flag.
        stale: this.#now() - fetchedAt >= MAX_AGE_MS
      }
      const source = (parsed as { source?: unknown }).source
      if (typeof source === 'string') {
        this.#source = source
      }
    } catch {
      // Corrupt cache: start with none and fetch fresh.
    }
  }
}

/** A rates map with at least one usable entry, or `undefined` if the body isn't one. */
function ratesOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const rates: Record<string, number> = {}
  for (const [code, rate] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^[A-Za-z]{3}$/u.test(code) &&
      typeof rate === 'number' &&
      Number.isFinite(rate) &&
      rate > 0
    ) {
      rates[code.toUpperCase()] = rate
    }
  }
  return Object.keys(rates).length > 0 ? rates : undefined
}
