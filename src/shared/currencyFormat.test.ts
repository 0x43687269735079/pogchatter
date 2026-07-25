import { describe, expect, it } from 'vitest'
import type { RateTable } from '@shared/donations'
import { convert, flagFor, formatMoney } from '@shared/currencyFormat'

const rates: RateTable = {
  base: 'GBP',
  rates: { JPY: 190, USD: 1.25, EUR: 1.15 },
  fetchedAt: 0,
  stale: false
}

describe('flagFor', () => {
  it('gives the flag of a currency with one home', () => {
    expect(flagFor('JPY')).toBe('🇯🇵')
    expect(flagFor('GBP')).toBe('🇬🇧')
    expect(flagFor('usd')).toBe('🇺🇸')
    expect(flagFor('EUR')).toBe('🇪🇺')
  })

  it('gives nothing for a currency shared across countries', () => {
    // Naming one member state as *the* issuer would misrepresent the others.
    expect(flagFor('XAF')).toBeUndefined()
    expect(flagFor('XCD')).toBeUndefined()
    expect(flagFor('ZZZ')).toBeUndefined()
  })
})

describe('formatMoney', () => {
  it('does not invent minor units for zero-decimal currencies', () => {
    expect(formatMoney(1500, 'JPY')).not.toContain('.')
    expect(formatMoney(10000, 'KRW')).not.toContain('.')
  })

  it('keeps two decimals for ordinary currencies', () => {
    expect(formatMoney(5, 'GBP')).toContain('5.00')
  })

  it('falls back to number plus code rather than throwing on an unknown code', () => {
    expect(formatMoney(5, 'ZZZZ')).toContain('ZZZZ')
  })
})

describe('convert', () => {
  it('converts a foreign amount into the base', () => {
    const value = { unit: 'money', amount: 1900, currency: 'JPY', original: '¥1,900' } as const
    expect(convert(value, rates, 'GBP')).toBeCloseTo(10)
  })

  it('returns the amount unchanged when it is already the base currency', () => {
    const value = { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' } as const
    expect(convert(value, rates, 'GBP')).toBe(5)
  })

  it('declines rather than guessing when it cannot convert honestly', () => {
    const unparsed = { unit: 'money-unparsed', original: 'kr 50' } as const
    const uncovered = { unit: 'money', amount: 10, currency: 'PEN', original: 'PEN 10' } as const
    const bits = { unit: 'bits', bits: 500 } as const
    expect(convert(unparsed, rates, 'GBP')).toBeUndefined()
    expect(convert(uncovered, rates, 'GBP')).toBeUndefined() // not in the table
    expect(convert(bits, rates, 'GBP')).toBeUndefined() // bits are not money
    expect(convert(uncovered, undefined, 'GBP')).toBeUndefined() // no rates yet
  })

  it('refuses a table fetched for a different base rather than cross-rating it', () => {
    const value = { unit: 'money', amount: 100, currency: 'JPY', original: '¥100' } as const
    expect(convert(value, rates, 'USD')).toBeUndefined()
  })
})
