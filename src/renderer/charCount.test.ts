import { describe, expect, it } from 'vitest'
import { MESSAGE_LIMIT } from '@shared/model'
import { charCount } from '@renderer/charCount'

describe('charCount', () => {
  it('says nothing while the draft is empty', () => {
    expect(charCount('', 'twitch')).toBeUndefined()
  })

  it('counts down against the platform’s own limit', () => {
    expect(charCount('a'.repeat(100), 'twitch')?.label).toBe('400 left')
    expect(charCount('a'.repeat(100), 'youtube')?.label).toBe('100 left')
  })

  it('charges an emoji the two units the send path charges it', () => {
    // The limit is measured in UTF-16 code units, so counting graphemes here would promise room
    // the message doesn't actually have.
    expect(charCount('🎉', 'twitch')?.label).toBe(`${MESSAGE_LIMIT.twitch - 2} left`)
  })

  it('stays quiet until the limit is close, then warns', () => {
    expect(charCount('a'.repeat(100), 'twitch')?.tone).toBe('plain')
    expect(charCount('a'.repeat(MESSAGE_LIMIT.twitch - 50), 'twitch')?.tone).toBe('near')
  })

  it('marks a draft past the limit', () => {
    expect(charCount('a'.repeat(MESSAGE_LIMIT.twitch + 1), 'twitch')?.tone).toBe('over')
  })

  it('tells a Twitch user how many messages an over-long draft will be sent as', () => {
    expect(charCount('a'.repeat(1200), 'twitch')?.label).toBe('700 over — sends as 3 messages')
  })

  it('reports the part count the splitter really produces, not a naive division', () => {
    // One early space then an unbroken run: the split breaks at that space, so this is 3 parts
    // even though dividing the length by the limit suggests 2.
    const draft = `${'a'.repeat(10)} ${'b'.repeat(980)}`
    expect(charCount(draft, 'twitch')?.label).toContain('sends as 3 messages')
  })

  it('tells a YouTube user the message is simply too long, since it will be rejected', () => {
    expect(charCount('a'.repeat(250), 'youtube')?.label).toBe('50 over the 200 limit')
  })
})
