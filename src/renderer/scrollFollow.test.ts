import { describe, expect, it } from 'vitest'
import { FOLLOWING, JUMPED, afterReaderScroll, afterScroll } from '@renderer/scrollFollow'

describe('scroll follow', () => {
  it('stops following when the reader scrolls up and resumes at the bottom', () => {
    const up = afterScroll(FOLLOWING, false)
    expect(up).toEqual({ pinned: false, held: false })
    expect(afterScroll(up, true)).toEqual({ pinned: true, held: false })
  })

  it('keeps a jumped view still even when the jump lands at the bottom', () => {
    expect(afterScroll(JUMPED, true)).toEqual(JUMPED)
    expect(afterScroll(JUMPED, false)).toEqual(JUMPED)
  })

  it('releases the hold once the reader scrolls, then follows the bottom again', () => {
    const released = afterReaderScroll(JUMPED)
    expect(released).toEqual({ pinned: false, held: false })
    expect(afterScroll(released, true)).toEqual(FOLLOWING)
  })

  it('leaves an unheld view alone on reader input', () => {
    expect(afterReaderScroll(FOLLOWING)).toBe(FOLLOWING)
    const up = { pinned: false, held: false }
    expect(afterReaderScroll(up)).toBe(up)
  })

  it('returns the same state when nothing changes, so callers can skip work', () => {
    expect(afterScroll(FOLLOWING, true)).toBe(FOLLOWING)
  })
})
