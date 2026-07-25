import type { DonationValue, RateTable } from '@shared/donations'

/**
 * Currencies with no minor unit. Formatting must not invent one: ¥1,500 is not ¥1,500.00, and showing
 * decimals on them reads as a tenfold error to anyone who uses them.
 */
const ZERO_DECIMAL = new Set([
  'JPY',
  'KRW',
  'VND',
  'CLP',
  'ISK',
  'HUF',
  'TWD',
  'UGX',
  'XAF',
  'XOF',
  'XPF',
  'RWF',
  'BIF',
  'DJF',
  'GNF',
  'KMF',
  'MGA',
  'PYG',
  'VUV'
])

/**
 * ISO 4217 → the ISO 3166-1 alpha-2 whose flag represents it.
 *
 * Only currencies with one obvious home are listed. Shared currencies (XAF/XOF across many states,
 * XCD across the Caribbean) are deliberately absent so no country is misrepresented as *the* issuer;
 * EUR maps to the EU flag, which is the honest answer for a shared currency that has one.
 */
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: 'US',
  EUR: 'EU',
  GBP: 'GB',
  JPY: 'JP',
  CNY: 'CN',
  KRW: 'KR',
  INR: 'IN',
  CAD: 'CA',
  AUD: 'AU',
  NZD: 'NZ',
  MXN: 'MX',
  BRL: 'BR',
  ARS: 'AR',
  CLP: 'CL',
  COP: 'CO',
  PEN: 'PE',
  CHF: 'CH',
  SEK: 'SE',
  NOK: 'NO',
  DKK: 'DK',
  PLN: 'PL',
  CZK: 'CZ',
  HUF: 'HU',
  RON: 'RO',
  BGN: 'BG',
  TRY: 'TR',
  RUB: 'RU',
  UAH: 'UA',
  ILS: 'IL',
  SAR: 'SA',
  AED: 'AE',
  ZAR: 'ZA',
  NGN: 'NG',
  KES: 'KE',
  EGP: 'EG',
  MAD: 'MA',
  SGD: 'SG',
  HKD: 'HK',
  TWD: 'TW',
  THB: 'TH',
  MYR: 'MY',
  IDR: 'ID',
  PHP: 'PH',
  VND: 'VN',
  PKR: 'PK',
  BDT: 'BD',
  LKR: 'LK',
  ISK: 'IS'
}

/**
 * The currency a locale implies, e.g. `en-GB` → `GBP`, falling back to USD.
 *
 * Derived by inverting {@link CURRENCY_COUNTRY} rather than carrying a second table, so the two can
 * never disagree. Used only to resolve a `baseCurrency` of `''` ("follow the system").
 */
export function localeCurrency(locale: string): string {
  const region = /[-_]([A-Za-z]{2})\b/u.exec(locale)?.[1]?.toUpperCase()
  if (region === undefined) {
    return 'USD'
  }
  for (const [currency, country] of Object.entries(CURRENCY_COUNTRY)) {
    if (country === region) {
      return currency
    }
  }
  return 'USD'
}

/** The flag for a currency's home, or `undefined` when it has no single one. */
export function flagFor(currency: string): string | undefined {
  const country = CURRENCY_COUNTRY[currency.toUpperCase()]
  if (country === undefined) {
    return undefined
  }
  // Regional indicator symbols: 'A' (0x41) maps to U+1F1E6, and a pair renders as that flag.
  return String.fromCodePoint(
    ...[...country].map((letter) => 0x1f1e6 + (letter.codePointAt(0) ?? 0) - 0x41)
  )
}

/** `amount` written the way `currency` is written, without inventing minor units. */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase()
  const digits = ZERO_DECIMAL.has(code) ? 0 : 2
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(amount)
  } catch {
    // A code Intl doesn't know (or a malformed one from the rate feed): show the number and the code
    // rather than nothing, and never throw inside a render.
    return `${amount.toFixed(digits)} ${code}`
  }
}

/**
 * `value` expressed in `base`, or `undefined` when that cannot be done honestly — a non-money value
 * (bits, a membership), an amount whose currency was never identified, or a currency the rate table
 * doesn't cover. Callers show the platform's original string in every one of those cases.
 */
export function convert(
  value: DonationValue,
  rates: RateTable | undefined,
  base: string
): number | undefined {
  if (value.unit !== 'money' || rates === undefined) {
    return undefined
  }
  const code = value.currency.toUpperCase()
  const target = base.toUpperCase()
  if (code === target) {
    return value.amount
  }
  if (rates.base.toUpperCase() !== target) {
    // The table was fetched for a different base; cross-rating it here would invent precision.
    return undefined
  }
  const perBase = rates.rates[code]
  if (perBase === undefined || perBase <= 0) {
    return undefined
  }
  return value.amount / perBase
}
