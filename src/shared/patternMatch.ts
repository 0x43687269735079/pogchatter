/**
 * User-supplied pattern matching shared by the renderer (highlights, watchlist) and the main
 * process (pre-ban auto-moderation). Rules run against every arriving message, so compiled
 * regexes are cached and patterns are bounded; an invalid pattern matches nothing, never throws.
 */

/**
 * User patterns longer than this are ignored rather than compiled: nothing legitimate needs more,
 * and the cap bounds the worst case of a hostile/accidental pattern evaluated on every message.
 */
export const MAX_PATTERN_LENGTH = 256

/**
 * Compiled-regex cache keyed by pattern. Each pattern must compile once — not once per message.
 * Invalid patterns cache as `undefined` (match nothing). Reset wholesale when it grows past the
 * size any real rule set reaches.
 */
const regexCache = new Map<string, RegExp | undefined>()

function compiledRegex(pattern: string): RegExp | undefined {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern)
  }
  if (regexCache.size >= 500) {
    regexCache.clear()
  }
  let regex: RegExp | undefined
  try {
    regex = new RegExp(pattern, 'i')
  } catch {
    regex = undefined
  }
  regexCache.set(pattern, regex)
  return regex
}

/** Whether a rule pattern is usable: non-empty, bounded, and (for regex rules) compilable. */
export function isValidPattern(pattern: string, isRegex: boolean): boolean {
  if (pattern === '' || pattern.length > MAX_PATTERN_LENGTH) {
    return false
  }
  return !isRegex || compiledRegex(pattern) !== undefined
}

/**
 * Whether a pattern matches the haystack: a case-insensitive substring, or — when `isRegex` — a
 * case-insensitive regular expression. An invalid or oversized pattern matches nothing rather
 * than throwing.
 */
export function matchesPattern(pattern: string, isRegex: boolean, haystack: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return false
  }
  if (isRegex) {
    return compiledRegex(pattern)?.test(haystack) ?? false
  }
  return haystack.toLowerCase().includes(pattern.toLowerCase())
}

function stripHandle(value: string): string {
  return (value.startsWith('@') ? value.slice(1) : value).toLowerCase()
}

/**
 * Whether a literal ban-rule pattern names an author exactly: case-insensitive, tolerating a
 * leading `@` on the pattern or the name. Ban rules deliberately reject substrings — substring
 * matching (the watchlist/highlight semantics above) would let a rule like "ann" ban "Hannah".
 */
export function matchesExactName(pattern: string, name: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return false
  }
  const wanted = stripHandle(pattern)
  return wanted !== '' && wanted === stripHandle(name)
}
