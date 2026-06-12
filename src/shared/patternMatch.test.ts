import { describe, expect, it } from 'vitest'
import { MAX_PATTERN_LENGTH, matchesExactName, matchesPattern } from '@shared/patternMatch'

describe('matchesPattern', () => {
  it('keeps substring semantics for literal watchlist/highlight patterns', () => {
    expect(matchesPattern('ann', false, 'Hannah')).toBe(true)
    expect(matchesPattern('BOB', false, 'spongebobfan')).toBe(true)
    expect(matchesPattern('zed', false, 'Hannah')).toBe(false)
  })

  it('treats regex patterns as case-insensitive regexes; invalid ones match nothing', () => {
    expect(matchesPattern('^han', true, 'Hannah')).toBe(true)
    expect(matchesPattern('[unclosed', true, 'Hannah')).toBe(false)
  })

  it('ignores oversized patterns instead of evaluating them', () => {
    const oversized = 'a'.repeat(MAX_PATTERN_LENGTH + 1)
    expect(matchesPattern(oversized, false, oversized)).toBe(false)
  })
})

describe('matchesExactName', () => {
  it('matches the whole name case-insensitively, never a substring', () => {
    expect(matchesExactName('hannah', 'Hannah')).toBe(true)
    expect(matchesExactName('HANNAH', 'hannah')).toBe(true)
    expect(matchesExactName('ann', 'Hannah')).toBe(false)
    expect(matchesExactName('hannah', 'hannah2')).toBe(false)
  })

  it('tolerates a leading @ on the pattern or the name', () => {
    expect(matchesExactName('@hannah', 'Hannah')).toBe(true)
    expect(matchesExactName('hannah', '@Hannah')).toBe(true)
    expect(matchesExactName('@hannah', '@hannah')).toBe(true)
    expect(matchesExactName('@ann', 'Hannah')).toBe(false)
  })

  it('rejects empty and oversized patterns', () => {
    expect(matchesExactName('', '')).toBe(false)
    expect(matchesExactName('@', '')).toBe(false)
    const oversized = 'a'.repeat(MAX_PATTERN_LENGTH + 1)
    expect(matchesExactName(oversized, oversized)).toBe(false)
  })
})
