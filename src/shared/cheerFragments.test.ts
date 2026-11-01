import { describe, expect, it } from 'vitest'
import type { Fragment } from '@shared/model'
import { isCheerAmount } from '@shared/cheerFragments'

const cheer: Fragment = { type: 'emote', code: 'Cheer100', url: 'u', provider: 'twitch' }
const amount: Fragment = { type: 'text', text: '100', verbatim: true }

describe('isCheerAmount', () => {
  it('recognises the amount that follows cheer artwork', () => {
    expect(isCheerAmount([cheer, amount], 1)).toBe(true)
  })

  it('leaves ordinary text, the first fragment, and non-Twitch emotes alone', () => {
    expect(isCheerAmount([cheer, { type: 'text', text: '100' }], 1)).toBe(false)
    expect(isCheerAmount([amount], 0)).toBe(false)
    expect(isCheerAmount([{ ...cheer, provider: '7tv' }, amount], 1)).toBe(false)
    expect(isCheerAmount([cheer, { ...amount, text: '50' }], 1)).toBe(false)
    expect(isCheerAmount([], 0)).toBe(false)
  })
})
