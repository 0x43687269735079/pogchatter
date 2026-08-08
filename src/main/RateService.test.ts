import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateService } from '@main/RateService'

const dir = join(tmpdir(), `pogchatter-rates-${process.pid}`)

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ok = (rates: unknown): Response =>
  ({ ok: true, json: async () => ({ rates }) }) as unknown as Response
const fail = (): Response => ({ ok: false, json: async () => ({}) }) as unknown as Response

describe('RateService', () => {
  it('fetches from the primary provider and exposes the table', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190, USD: 1.25 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')

    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('er-api')
    expect(service.table()).toEqual({
      base: 'GBP',
      rates: { JPY: 190, USD: 1.25 },
      fetchedAt: 1_000,
      stale: false
    })
    expect(service.source()).toBe('ExchangeRate-API')
  })

  it('falls through to the fallback provider when the primary fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok({ JPY: 191 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1 })
    await service.refresh('GBP')

    expect(String(fetchFn.mock.calls[1]?.[0])).toContain('frankfurter')
    expect(service.table()?.rates).toEqual({ JPY: 191 })
    expect(service.source()).toBe('Frankfurter')
  })

  it('keeps the previous rates and marks them stale when every provider fails', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    let clock = 1_000
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => clock })
    await service.refresh('GBP')

    fetchFn.mockRejectedValue(new Error('offline'))
    clock += 48 * 60 * 60 * 1000
    await service.refresh('GBP')

    expect(service.table()?.rates).toEqual({ JPY: 190 }) // yesterday's, still usable
    expect(service.table()?.stale).toBe(true) // but never passed off as current
  })

  it('does not replace good rates with a malformed body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    let clock = 1_000
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => clock })
    await service.refresh('GBP')

    fetchFn.mockResolvedValue(ok({ JPY: 'not a number', '': 1 }))
    clock += 48 * 60 * 60 * 1000
    await service.refresh('GBP')

    expect(service.table()?.rates).toEqual({ JPY: 190 })
    expect(service.table()?.stale).toBe(true)
  })

  it('makes no request while the cache is fresh, and refetches when the base changes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    await service.refresh('GBP')
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await service.refresh('USD') // a different base cannot be served from a GBP table
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reuses a fresh disk cache on restart without calling it stale', async () => {
    // Staleness is about age. Asserting it on every load meant a cache written minutes ago was
    // reported as unrefreshable, since refresh short-circuits while fresh and never cleared it.
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    await new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 }).refresh('GBP')

    const reopened = new RateService({ dir, fetchFn: fetchFn as never, now: () => 2_000 })
    expect(reopened.table()?.rates).toEqual({ JPY: 190 })
    expect(reopened.table()?.stale).toBe(false)
  })

  it('marks a genuinely old disk cache stale', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    await new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 }).refresh('GBP')

    const later = 1_000 + 48 * 60 * 60 * 1000
    expect(
      new RateService({ dir, fetchFn: fetchFn as never, now: () => later }).table()?.stale
    ).toBe(true)
  })

  it('refuses a future timestamp in the cache, which would suppress refreshes forever', async () => {
    // JSON.parse turns 1e999 into Infinity, which passes a bare typeof check and makes the
    // freshness test permanently true.
    writeFileSync(
      join(dir, 'rates.json'),
      '{"table":{"base":"GBP","rates":{"JPY":190},"fetchedAt":1e999}}'
    )
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 191 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 5_000 })
    await service.refresh('GBP')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(service.table()?.rates).toEqual({ JPY: 191 })
  })

  it('never rejects, whatever the network does', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('DNS is on fire'))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1 })
    await expect(service.refresh('GBP')).resolves.toBeUndefined()
    expect(service.table()).toBeUndefined() // nothing to show, and nothing broken
  })
})

describe('RateService coverage and request budget', () => {
  it('asks the wide-coverage provider first, so the long-tail currencies convert at all', async () => {
    // The bug this pins: Frankfurter serves only the ECB basket (30 currencies), and it does not
    // *fail* on a Costa Rican colon — it returns a valid table without one. Leading with it meant
    // ~40 of YouTube's Super Chat currencies were permanently written off as unrecognised.
    const fetchFn = vi.fn().mockResolvedValue(ok({ CRC: 609.44, JPY: 216.66, VND: 35040 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1 })
    await service.refresh('GBP')

    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('er-api')
    expect(service.table()?.rates['CRC']).toBeCloseTo(609.44)
    expect(service.table()?.rates['VND']).toBeCloseTo(35040)
  })

  it('costs exactly one request on an ordinary day', async () => {
    // The whole point of caching for a day: the free endpoints are fair-use, and one call a day
    // sits far inside that. A second provider is only ever touched when the first says nothing.
    const fetchFn = vi.fn().mockResolvedValue(ok({ CRC: 609.44 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    await service.refresh('GBP')
    await service.refresh('GBP')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('RateService coverage recovery', () => {
  it('fetches again when a donation needs a currency the table lacks', async () => {
    // The narrow fallback covers 30 currencies; a Costa Rican tip under it would otherwise stay
    // unconvertible until the next daily tick.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok({ JPY: 190 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    expect(service.source()).toBe('Frankfurter') // on the narrow provider

    fetchFn.mockResolvedValue(ok({ JPY: 190, CRC: 609 }))
    service.recoverMissing('GBP', 'CRC')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.table()?.rates['CRC']).toBe(609)
  })

  it('does not re-ask when the widest provider already answered and simply has no such rate', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    expect(fetchFn).toHaveBeenCalledTimes(1)

    service.recoverMissing('GBP', 'XYZ') // fresh, from the widest source — asking again is pointless
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the rate is already there', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    service.recoverMissing('GBP', 'JPY')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not fetch for the base currency itself', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ JPY: 190 }))
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })
    await service.refresh('GBP')
    service.recoverMissing('GBP', 'GBP') // convert handles same-currency directly; nothing to fetch
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('announces a coverage-recovery result through onChange so the panel can update', async () => {
    // Recovery updates the table out of band; without a change notification an open panel would keep
    // showing the donation as excluded until a reload.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok({ JPY: 190 }))
    let changes = 0
    const service = new RateService({
      dir,
      fetchFn: fetchFn as never,
      now: () => 1_000,
      onChange: () => {
        changes += 1
      }
    })
    await service.refresh('GBP') // lands on Frankfurter (one change)
    expect(changes).toBe(1)

    fetchFn.mockResolvedValue(ok({ JPY: 190, CRC: 609 }))
    service.recoverMissing('GBP', 'CRC')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.table()?.rates['CRC']).toBe(609)
    expect(changes).toBe(2) // recovery committed and announced
  })
})

describe('RateService concurrent base changes', () => {
  it('commits the base chosen last even when an earlier one resolves last', async () => {
    // A base change while the first fetch is in flight (GBP then EUR). If GBP resolves last it must not
    // overwrite EUR — otherwise the panel silently reverts to a base the user already left.
    const gbp = deferred()
    const eur = deferred()
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => gbp.promise)
      .mockImplementationOnce(() => eur.promise)
    const service = new RateService({ dir, fetchFn: fetchFn as never, now: () => 1_000 })

    const gbpDone = service.refresh('GBP')
    const eurDone = service.refresh('EUR')
    eur.resolve(ok({ JPY: 160 }))
    await eurDone
    gbp.resolve(ok({ JPY: 190 }))
    await gbpDone

    expect(service.table()?.base).toBe('EUR')
    expect(service.table()?.rates).toEqual({ JPY: 160 })
  })
})

function deferred(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
