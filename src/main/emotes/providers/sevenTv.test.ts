import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/emotes/httpJson', () => ({ getJson: vi.fn() }))

import { getJson } from '@main/emotes/httpJson'
import { fetchSevenTvChannel } from '@main/emotes/providers/sevenTv'

const mockGet = vi.mocked(getJson)

afterEach(() => {
  mockGet.mockReset()
})

describe('fetchSevenTvChannel', () => {
  it('includes unlisted emotes (data.listed === false) for maximum coverage', async () => {
    mockGet.mockResolvedValue({
      emote_set: {
        id: 'set-123',
        emotes: [
          { id: 'a', name: 'Listed', data: { listed: true, animated: false } },
          { id: 'b', name: 'AlienRave', data: { listed: false, animated: true } }
        ]
      }
    })

    const out = await fetchSevenTvChannel('twitch', '71092938')

    expect(out.setId).toBe('set-123')
    expect(out.emotes.map((e) => e.code)).toEqual(['Listed', 'AlienRave'])
    expect(out.emotes[1]).toMatchObject({
      code: 'AlienRave',
      provider: '7tv',
      url: 'https://cdn.7tv.app/emote/b/2x.webp',
      animated: true
    })
  })

  it('flags zero-width emotes from either the active or emote flags', async () => {
    mockGet.mockResolvedValue({
      emote_set: {
        emotes: [
          { id: 'z', name: 'Overlay', flags: 1, data: { listed: true } },
          { id: 'w', name: 'Wide', flags: 0, data: { listed: true, flags: 256 } }
        ]
      }
    })

    const out = await fetchSevenTvChannel('twitch', '1')

    expect(out.emotes.every((e) => e.zeroWidth)).toBe(true)
  })

  it('returns an empty set with no id when the channel has no 7TV account (404 → null)', async () => {
    mockGet.mockResolvedValue(null)

    const out = await fetchSevenTvChannel('twitch', '1')

    expect(out).toEqual({ setId: undefined, emotes: [] })
  })

  it('propagates a provider failure so the engine can retry instead of caching empty', async () => {
    mockGet.mockRejectedValue(new Error('GET https://7tv.io failed: 503'))

    await expect(fetchSevenTvChannel('twitch', '1')).rejects.toThrow('503')
  })
})
