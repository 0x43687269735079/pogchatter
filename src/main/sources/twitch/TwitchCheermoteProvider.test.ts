import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchCheermoteProvider } from '@main/sources/twitch/TwitchCheermoteProvider'

const proxiedFetch = vi.hoisted(() => vi.fn())
vi.mock('@main/net/proxy', () => ({ proxiedFetch }))

function helixResponse(data: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => ({ data }) }
}

/** Global "Cheer" with three tiers: animated where available, static for the 1000 tier. */
const CHEER = {
  prefix: 'Cheer',
  tiers: [
    {
      min_bits: 1,
      images: {
        dark: {
          animated: { '1': 'cheer1@1x.gif', '2': 'cheer1.gif' },
          static: { '2': 'cheer1.png' }
        }
      }
    },
    { min_bits: 100, images: { dark: { animated: { '2': 'cheer100.gif' } } } },
    { min_bits: 1000, images: { dark: { static: { '2': 'cheer1000.png' } } } }
  ]
}

beforeEach(() => {
  proxiedFetch.mockReset()
})

describe('TwitchCheermoteProvider', () => {
  it('parses tiers and resolves the tier the bits amount falls into, case-insensitively', async () => {
    proxiedFetch.mockResolvedValueOnce(helixResponse([CHEER]))
    const provider = new TwitchCheermoteProvider()
    await provider.ensureGlobal('token', 'client')
    expect(provider.names(undefined)).toEqual(['cheer'])
    expect(provider.resolve(undefined, 'cheer', 250)).toEqual({
      url: 'cheer100.gif',
      animated: true
    })
    expect(provider.resolve(undefined, 'Cheer', 1)).toEqual({ url: 'cheer1.gif', animated: true })
    expect(provider.resolve(undefined, 'Cheer', 5000)).toEqual({
      url: 'cheer1000.png',
      animated: false
    })
    expect(provider.resolve(undefined, 'Unknown', 100)).toBeUndefined()
  })

  it('caches a loaded set but retries after a failed fetch', async () => {
    proxiedFetch.mockResolvedValueOnce({ ok: false })
    const provider = new TwitchCheermoteProvider()
    await provider.ensureGlobal('token', 'client')
    expect(provider.names(undefined)).toEqual([])
    proxiedFetch.mockResolvedValueOnce(helixResponse([CHEER]))
    await provider.ensureGlobal('token', 'client')
    expect(provider.names(undefined)).toEqual(['cheer'])
    await provider.ensureGlobal('token', 'client')
    expect(proxiedFetch).toHaveBeenCalledTimes(2)
  })

  it("prefers the channel's set (which includes the global cheermotes) for its room", async () => {
    proxiedFetch.mockResolvedValueOnce(helixResponse([CHEER]))
    const provider = new TwitchCheermoteProvider()
    await provider.ensureGlobal('token', 'client')
    proxiedFetch.mockResolvedValueOnce(
      helixResponse([
        CHEER,
        {
          prefix: 'Kreygasm',
          tiers: [{ min_bits: 1, images: { dark: { animated: { '2': 'krey.gif' } } } }]
        }
      ])
    )
    await provider.ensureChannel('500', 'token', 'client')
    expect(provider.names('500').sort()).toEqual(['cheer', 'kreygasm'])
    expect(provider.resolve('500', 'kreygasm', 50)).toEqual({ url: 'krey.gif', animated: true })
    // Rooms without a loaded channel set fall back to the global one.
    expect(provider.names('999')).toEqual(['cheer'])
    expect(provider.resolve('999', 'kreygasm', 50)).toBeUndefined()
  })

  it('treats a network error as not-fetched without throwing', async () => {
    proxiedFetch.mockRejectedValueOnce(new Error('offline'))
    const provider = new TwitchCheermoteProvider()
    await provider.ensureGlobal('token', 'client')
    expect(provider.names(undefined)).toEqual([])
  })
})
