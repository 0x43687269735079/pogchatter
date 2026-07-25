import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RateTable } from '@shared/donations'
import { proxiedFetch } from '@main/net/proxy'

/** Rates are daily figures at both providers, so asking more often only adds traffic. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A rate fetch is never worth making anyone wait; it is background work with a hard ceiling. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Primary: Frankfurter — no API key, no rate cap, open source and self-hostable, sourced from
 * central banks. Fallback: ExchangeRate-API's open endpoint — also keyless, updated daily, and
 * rate-limited, which is why it is second rather than first.
 *
 * Attribution: ExchangeRate-API asks for credit when the open endpoint is used; the panel names
 * whichever provider supplied the rates it is showing.
 */
const PROVIDERS: ReadonlyArray<{
  name: string
  url: (base: string) => string
  parse: (body: unknown) => Record<string, number> | undefined
}> = [
  {
    name: 'Frankfurter',
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${base}`,
    parse: (body) => ratesOf((body as { rates?: unknown }).rates)
  },
  {
    name: 'ExchangeRate-API',
    url: (base) => `https://open.er-api.com/v6/latest/${base}`,
    parse: (body) => ratesOf((body as { rates?: unknown }).rates)
  }
]

export interface RateServiceDeps {
  dir: string
  fetchFn?: typeof fetch
  now?: () => number
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
  #table: RateTable | undefined
  /** Provider that supplied the current table, for the attribution line. */
  #source: string | undefined
  #inFlight: Promise<void> | undefined

  constructor(deps: RateServiceDeps) {
    this.#path = join(deps.dir, 'rates.json')
    this.#fetch = deps.fetchFn ?? proxiedFetch
    this.#now = deps.now ?? Date.now
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
    if (this.#inFlight !== undefined) {
      return this.#inFlight
    }
    const current = this.#table
    if (
      current !== undefined &&
      current.base === wanted &&
      this.#now() - current.fetchedAt < MAX_AGE_MS
    ) {
      return
    }
    this.#inFlight = this.#fetchFrom(wanted).finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  async #fetchFrom(base: string): Promise<void> {
    for (const provider of PROVIDERS) {
      const rates = await this.#tryProvider(provider, base)
      if (rates !== undefined) {
        this.#table = { base, rates, fetchedAt: this.#now(), stale: false }
        this.#source = provider.name
        this.#persist()
        return
      }
    }
    // Both providers failed. Keep serving what we have, but say that it is old rather than passing
    // yesterday's figures off as today's.
    if (this.#table !== undefined) {
      this.#table = { ...this.#table, stale: true }
    }
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
      this.#table = {
        base: table.base.toUpperCase(),
        rates,
        fetchedAt: typeof table.fetchedAt === 'number' ? table.fetchedAt : 0,
        stale: true // Until a refresh confirms it, a cache read from disk is yesterday's news.
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
