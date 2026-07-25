/**
 * Recovers a numeric amount and an ISO 4217 currency from a platform's *localised* amount string.
 *
 * This exists because YouTube gives us nothing better: a paid-message payload carries only
 * `purchaseAmountText` — a display string like `"$5.00"` or `"¥1,500"` — with no currency field and no
 * minor-unit integer (verified against a captured live response). Every converted figure in the
 * donations panel therefore rests on this parse.
 *
 * The governing rule is **never guess**. A symbol that could mean several currencies (`kr` for
 * SEK/NOK/DKK/ISK) is not mapped at all, and anything unrecognised returns `undefined` so the caller
 * shows the platform's own string verbatim. A wrong currency would silently misstate money.
 */

/**
 * Symbol → ISO 4217, longest-first so `CA$` wins over `$` and `CN¥` over `¥`.
 *
 * Deliberately absent: `kr` (SEK/NOK/DKK/ISK), `₨` (several rupees), and bare `R` (ZAR vs BRL) —
 * ambiguous symbols must fall through to `undefined` rather than resolve to a plausible guess.
 * Currencies YouTube writes as an ISO code instead (CHF, SEK, PLN…) are handled by the code path.
 */
const SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['CA$', 'CAD'],
  ['CN¥', 'CNY'],
  ['US$', 'USD'],
  ['MX$', 'MXN'],
  ['NZ$', 'NZD'],
  ['HK$', 'HKD'],
  ['NT$', 'TWD'],
  ['AR$', 'ARS'],
  ['A$', 'AUD'],
  ['R$', 'BRL'],
  ['S$', 'SGD'],
  ['Rp', 'IDR'],
  ['RM', 'MYR'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['$', 'USD'],
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
  ['₩', 'KRW'],
  ['₹', 'INR'],
  ['₱', 'PHP'],
  ['₪', 'ILS'],
  ['₺', 'TRY'],
  ['₴', 'UAH'],
  ['₦', 'NGN'],
  ['₽', 'RUB'],
  ['₫', 'VND'],
  ['₡', 'CRC'],
  ['฿', 'THB']
]

/** Spaces YouTube uses between a code and its digits, none of which are a plain space. */
const ODD_SPACES = /[    ⁠]/gu

/** `display` as an amount and currency, or `undefined` when either cannot be established. */
export function parseAmount(display: string): { amount: number; currency: string } | undefined {
  const text = display.replace(ODD_SPACES, ' ').replace(/\s+/gu, ' ').trim()
  if (text === '') {
    return undefined
  }
  return fromIsoCode(text) ?? fromSymbol(text)
}

/** `"PHP 250.00"` / `"250.00 CHF"` — a three-letter code is by construction already ISO 4217. */
function fromIsoCode(text: string): { amount: number; currency: string } | undefined {
  const match = /^([A-Za-z]{3}) ?([\d.,]+)$/u.exec(text) ?? /^([\d.,]+) ?([A-Za-z]{3})$/u.exec(text)
  if (match === null) {
    return undefined
  }
  const [first = '', second = ''] = [match[1] ?? '', match[2] ?? '']
  const isCodeFirst = /^[A-Za-z]{3}$/u.test(first)
  const amount = parseNumber(isCodeFirst ? second : first)
  if (amount === undefined) {
    return undefined
  }
  return { amount, currency: (isCodeFirst ? first : second).toUpperCase() }
}

/** `"$5.00"` / `"5,00 zł"` — the symbol may lead or trail. */
function fromSymbol(text: string): { amount: number; currency: string } | undefined {
  for (const [symbol, currency] of SYMBOLS) {
    const digits = text.startsWith(symbol)
      ? text.slice(symbol.length)
      : text.endsWith(symbol)
        ? text.slice(0, -symbol.length)
        : undefined
    if (digits === undefined) {
      continue
    }
    const amount = parseNumber(digits)
    if (amount !== undefined) {
      return { amount, currency }
    }
  }
  return undefined
}

/**
 * A grouped decimal in either convention — `1,234.56` and `1.234,56` both mean 1234.56.
 *
 * Which separator is decimal is decided structurally, never by locale guessing: with both present the
 * later one is the decimal point; with one kind repeated it is grouping; with a single separator,
 * exactly three trailing digits means grouping (`1,500` is fifteen hundred, not one and a half).
 */
function parseNumber(raw: string): number | undefined {
  const text = raw.replace(/ /gu, '')
  if (!/^[\d.,]+$/u.test(text) || !/\d/u.test(text)) {
    return undefined
  }
  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  let decimalAt = -1
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma)
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = lastDot >= 0 ? '.' : ','
    const at = lastDot >= 0 ? lastDot : lastComma
    const repeated = text.indexOf(only) !== text.lastIndexOf(only)
    decimalAt = repeated || text.length - at - 1 === 3 ? -1 : at
  }
  const wholeRaw = decimalAt >= 0 ? text.slice(0, decimalAt) : text
  // Any separator left in the whole part is grouping, so the groups must actually be groups —
  // otherwise "1.2.3" would collapse to 123 instead of being rejected as not a number.
  if (/[.,]/u.test(wholeRaw)) {
    const [head, ...rest] = wholeRaw.split(/[.,]/u)
    if (head === undefined || head === '' || head.length > 3) {
      return undefined
    }
    if (rest.some((group) => group.length !== 3)) {
      return undefined
    }
  }
  const whole = wholeRaw.replace(/[.,]/gu, '')
  const fraction = decimalAt >= 0 ? text.slice(decimalAt + 1) : ''
  if (whole === '' || /[.,]/u.test(fraction)) {
    return undefined
  }
  const value = Number(fraction === '' ? whole : `${whole}.${fraction}`)
  return Number.isFinite(value) ? value : undefined
}
