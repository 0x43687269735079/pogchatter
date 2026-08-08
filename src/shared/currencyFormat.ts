import type { DonationValue, RateTable } from '@shared/donations'

/**
 * Fallback minor-unit digits for runtimes without full ICU. Currencies not listed take two.
 *
 * Both extremes matter and for opposite reasons: writing ¥1,500.00 invents precision the yen has no
 * concept of, while writing BHD 1.23 *discards* a digit of someone's money. HUF and TWD are
 * deliberately absent — often displayed without decimals, but ISO 4217 gives them two.
 */
const FALLBACK_DIGITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  UGX: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  RWF: 0,
  BIF: 0,
  DJF: 0,
  GNF: 0,
  KMF: 0,
  PYG: 0,
  VUV: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3
}

/** Cached per currency: `Intl` lookups are not free and this is called per row and per parse. */
const digitCache = new Map<string, number>()

/**
 * How many minor-unit digits a currency has — 0 for the yen, 2 for most, 3 for the Gulf dinars.
 *
 * Asked of `Intl` rather than hard-coded, because the answer governs both *formatting* and
 * *parsing*: it is what stops "BHD 1.234" being read as one thousand two hundred and thirty-four
 * dinars. A hand-kept table would eventually disagree with the platform about someone's money.
 */
export function minorDigitsFor(currency: string): number {
  const code = currency.toUpperCase()
  const cached = digitCache.get(code)
  if (cached !== undefined) {
    return cached
  }
  let digits = FALLBACK_DIGITS[code] ?? 2
  try {
    const resolved = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code
    }).resolvedOptions().maximumFractionDigits
    if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved >= 0) {
      digits = resolved
    }
  } catch {
    // Unknown code or no ICU — the fallback above stands.
  }
  digitCache.set(code, digits)
  return digits
}

/**
 * Every ISO 3166-1 alpha-2 code, plus `EU` for the euro.
 *
 * Used only to confirm that a code derived from a currency is a real place before it becomes a flag:
 * without the check, an unknown or retired currency would render as two bare letter tiles.
 */
const COUNTRIES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS
   BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE
   EG EH ER ES ET EU FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK
   HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB
   LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU
   RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN
   TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/u)
)

/**
 * Currencies whose code does not begin with their country's code. Vanishingly few do — see
 * {@link countryFor} — so this stays a short list of genuine exceptions rather than a full table.
 */
const COUNTRY_OVERRIDES: Record<string, string> = {
  // Pre-2023 codes still seen in older amounts, now superseded by the euro.
  HRK: 'HR',
  // The pound's code predates the alpha-2 scheme; GB happens to work, but spell it out rather than
  // rely on coincidence.
  GBP: 'GB'
}

/**
 * The country a currency belongs to, or `undefined` when it has no single one.
 *
 * ISO 4217 builds almost every code from the country's ISO 3166-1 alpha-2 code plus a letter naming
 * the unit — GB+P, JP+Y, BR+L, ZA+R — so the country is derivable rather than something to maintain
 * a table of. That matters here: YouTube takes Super Chats in around a hundred locations and can add
 * more, and a hand-kept list would silently lose the flag for whichever currency it missed. Codes
 * beginning with `X` are supranational (XOF across West Africa, XPF across French Polynesia) and
 * name no single country, so they correctly get no flag.
 */
function countryFor(currency: string): string | undefined {
  const code = currency.toUpperCase()
  const override = COUNTRY_OVERRIDES[code]
  if (override !== undefined) {
    return override
  }
  if (code.length !== 3 || code.startsWith('X')) {
    return undefined
  }
  // The euro is shared, but unlike the X-codes it has a flag of its own.
  const country = code === 'EUR' ? 'EU' : code.slice(0, 2)
  return COUNTRIES.has(country) ? country : undefined
}

/**
 * The currency a locale implies, e.g. `en-GB` → `GBP`, falling back to USD. Used only to resolve a
 * `baseCurrency` of `''` ("follow the system").
 */
export function localeCurrency(locale: string): string {
  const region = /[-_]([A-Za-z]{2})\b/u.exec(locale)?.[1]?.toUpperCase()
  if (region === undefined || !COUNTRIES.has(region)) {
    return 'USD'
  }
  return LOCALE_CURRENCY[region] ?? 'USD'
}

/**
 * Region → currency for the places a user of this app is plausibly in. Only needed for the reverse
 * direction (a locale has no currency in it), so it stays small: anything unlisted falls back to USD,
 * and the user can set their currency explicitly.
 */
const LOCALE_CURRENCY: Record<string, string> = {
  US: 'USD',
  GB: 'GBP',
  JP: 'JPY',
  CN: 'CNY',
  KR: 'KRW',
  IN: 'INR',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  MX: 'MXN',
  BR: 'BRL',
  AR: 'ARS',
  CL: 'CLP',
  CO: 'COP',
  PE: 'PEN',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  RO: 'RON',
  BG: 'BGN',
  TR: 'TRY',
  RU: 'RUB',
  UA: 'UAH',
  IL: 'ILS',
  SA: 'SAR',
  AE: 'AED',
  ZA: 'ZAR',
  NG: 'NGN',
  KE: 'KES',
  EG: 'EGP',
  MA: 'MAD',
  SG: 'SGD',
  HK: 'HKD',
  TW: 'TWD',
  TH: 'THB',
  MY: 'MYR',
  ID: 'IDR',
  PH: 'PHP',
  VN: 'VND',
  PK: 'PKR',
  BD: 'BDT',
  LK: 'LKR',
  IS: 'ISK',
  // The euro area — every member resolves to the same currency.
  AT: 'EUR',
  BE: 'EUR',
  CY: 'EUR',
  DE: 'EUR',
  EE: 'EUR',
  ES: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GR: 'EUR',
  HR: 'EUR',
  IE: 'EUR',
  IT: 'EUR',
  LT: 'EUR',
  LU: 'EUR',
  LV: 'EUR',
  MT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  SI: 'EUR',
  SK: 'EUR'
}

/**
 * Built lazily and reused: constructing an `Intl.DisplayNames` per render would be wasteful, and it
 * throws on runtimes without full ICU, which must not take a render down.
 */
let regionNames: Intl.DisplayNames | undefined | null

/**
 * The country a currency belongs to, in words — "Japan", "Brazil" — for the flag's tooltip, so the
 * flag is decoration over a name rather than a picture the reader has to recognise.
 *
 * `undefined` when the currency has no single country (the supranational codes) or when the runtime
 * can't name regions; callers then fall back to the currency code, which is always shown anyway.
 */
export function countryName(currency: string): string | undefined {
  const country = countryFor(currency)
  if (country === undefined) {
    return undefined
  }
  if (country === 'EU') {
    return 'European Union'
  }
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: 'region' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(country) ?? undefined
  } catch {
    return undefined
  }
}

/** The flag for a currency's home, or `undefined` when it has no single one. */
export function flagFor(currency: string): string | undefined {
  const country = countryFor(currency)
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
  const digits = minorDigitsFor(code)
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
  if (value.unit !== 'money') {
    return undefined
  }
  const code = value.currency.toUpperCase()
  const target = base.toUpperCase()
  // Settled before rates are consulted: a donation already in the base currency needs no conversion,
  // so requiring a rate table first would report it as unconvertible and drop it from the totals
  // whenever rates are missing — zeroing the session figure on a first run or offline.
  if (code === target) {
    return value.amount
  }
  if (rates === undefined) {
    return undefined
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
