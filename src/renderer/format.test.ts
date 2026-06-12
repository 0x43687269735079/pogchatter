import { describe, expect, it } from 'vitest'
import { atName, clockHM } from '@renderer/format'

describe('atName', () => {
  it('adds @ to a bare name (Twitch display names)', () => {
    expect(atName('fallenshadow')).toBe('@fallenshadow')
  })

  it('leaves an existing @ untouched (YouTube handles)', () => {
    expect(atName('@KozumiNezō')).toBe('@KozumiNezō')
  })
})

describe('clockHM', () => {
  // Local times so the test doesn't depend on the runner's timezone.
  const now = new Date(2026, 5, 8, 12, 0) // 8 Jun 2026, 12:00

  it('shows just HH:MM for a message from the same day', () => {
    expect(clockHM(new Date(2026, 5, 8, 18, 39).getTime(), now)).toBe('18:39')
    expect(clockHM(new Date(2026, 5, 8, 9, 5).getTime(), now)).toBe('09:05')
  })

  it('prefixes the date for a message from another day', () => {
    expect(clockHM(new Date(2026, 5, 7, 18, 39).getTime(), now)).toBe('7 Jun 18:39')
    expect(clockHM(new Date(2026, 0, 2, 10, 52).getTime(), now)).toBe('2 Jan 10:52')
  })
})
