import { describe, expect, it } from 'vitest'
import { parseAmount } from '@shared/currencyParse'

describe('parseAmount', () => {
  it('reads the plain symbol forms', () => {
    expect(parseAmount('$5.00')).toEqual({ amount: 5, currency: 'USD' })
    expect(parseAmount('£5.00')).toEqual({ amount: 5, currency: 'GBP' })
    expect(parseAmount('₹100.00')).toEqual({ amount: 100, currency: 'INR' })
  })

  it('prefers the longer symbol so prefixed dollars are not read as US dollars', () => {
    // The whole reason a bare "$" cannot be assumed: YouTube disambiguates by prefix.
    expect(parseAmount('CA$5.00')).toEqual({ amount: 5, currency: 'CAD' })
    expect(parseAmount('A$10.00')).toEqual({ amount: 10, currency: 'AUD' })
    expect(parseAmount('MX$100.00')).toEqual({ amount: 100, currency: 'MXN' })
    expect(parseAmount('NZ$7.50')).toEqual({ amount: 7.5, currency: 'NZD' })
    expect(parseAmount('HK$40.00')).toEqual({ amount: 40, currency: 'HKD' })
    expect(parseAmount('R$20,00')).toEqual({ amount: 20, currency: 'BRL' })
    expect(parseAmount('CN¥50.00')).toEqual({ amount: 50, currency: 'CNY' })
    expect(parseAmount('¥500')).toEqual({ amount: 500, currency: 'JPY' })
  })

  it('reads an ISO code before or after the digits', () => {
    expect(parseAmount('PHP 250.00')).toEqual({ amount: 250, currency: 'PHP' })
    expect(parseAmount('CHF 5.00')).toEqual({ amount: 5, currency: 'CHF' })
    expect(parseAmount('SEK 50,00')).toEqual({ amount: 50, currency: 'SEK' })
    expect(parseAmount('50.00 NOK')).toEqual({ amount: 50, currency: 'NOK' })
  })

  it('reads a trailing symbol', () => {
    expect(parseAmount('5,00 zł')).toEqual({ amount: 5, currency: 'PLN' })
    expect(parseAmount('120 ₽')).toEqual({ amount: 120, currency: 'RUB' })
  })

  it('handles both decimal conventions', () => {
    expect(parseAmount('$1,234.56')?.amount).toBe(1234.56)
    expect(parseAmount('€1.234,56')?.amount).toBe(1234.56)
    expect(parseAmount('€5,00')?.amount).toBe(5)
    expect(parseAmount('$1,234,567.89')?.amount).toBe(1234567.89)
  })

  it('treats exactly three trailing digits after a lone separator as grouping', () => {
    // "¥1,500" is fifteen hundred yen, not one and a half.
    expect(parseAmount('¥1,500')?.amount).toBe(1500)
    expect(parseAmount('€1.500')?.amount).toBe(1500)
    // Two digits is a decimal fraction, not a group.
    expect(parseAmount('€1,50')?.amount).toBe(1.5)
  })

  it('tolerates the non-breaking and narrow spaces platforms emit', () => {
    expect(parseAmount('CHF 5.00')).toEqual({ amount: 5, currency: 'CHF' })
    expect(parseAmount('1 234,56 zł')?.amount).toBe(1234.56)
  })

  it('refuses to guess rather than risk misstating money', () => {
    expect(parseAmount('kr 50')).toBeUndefined() // SEK? NOK? DKK? ISK?
    expect(parseAmount('5.00')).toBeUndefined() // no currency at all
    expect(parseAmount('¤5.00')).toBeUndefined() // unknown symbol
    expect(parseAmount('')).toBeUndefined()
    expect(parseAmount('free')).toBeUndefined()
    expect(parseAmount('$')).toBeUndefined() // symbol with no number
    expect(parseAmount('$1.2.3')).toBeUndefined() // not a number we understand
  })

  it('keeps zero-decimal amounts whole', () => {
    expect(parseAmount('¥1500')).toEqual({ amount: 1500, currency: 'JPY' })
    expect(parseAmount('₩10,000')).toEqual({ amount: 10000, currency: 'KRW' })
  })
})
