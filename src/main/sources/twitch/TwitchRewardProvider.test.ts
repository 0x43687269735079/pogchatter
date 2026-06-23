import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchRewardProvider } from '@main/sources/twitch/TwitchRewardProvider'

const proxiedFetch = vi.hoisted(() => vi.fn())
vi.mock('@main/net/proxy', () => ({ proxiedFetch }))

/** A GraphQL reward-catalog response carrying the given custom rewards. */
function catalog(rewards: { id: string; title: string }[]): {
  ok: true
  json: () => Promise<unknown>
} {
  return {
    ok: true,
    json: async () => ({
      data: { user: { channel: { communityPointsSettings: { customRewards: rewards } } } }
    })
  }
}

beforeEach(() => {
  proxiedFetch.mockReset()
})

describe('TwitchRewardProvider', () => {
  it('resolves a reward UUID to its title and queries by login via GraphQL', async () => {
    proxiedFetch.mockResolvedValue(catalog([{ id: 'uuid-1', title: 'Hydrate!' }]))
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'uuid-1')).toBe('Hydrate!')
    // The request carries the login as a GraphQL variable, not interpolated into the query.
    const init = proxiedFetch.mock.calls[0]?.[1] as { body?: string } | undefined
    const body = JSON.parse(init?.body ?? '{}') as { variables?: unknown }
    expect(body.variables).toEqual({ login: 'caseoh_' })
  })

  it('returns undefined for an unknown reward or channel', async () => {
    proxiedFetch.mockResolvedValue(catalog([{ id: 'uuid-1', title: 'Hydrate!' }]))
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'nope')).toBeUndefined()
    expect(provider.resolve('other', 'uuid-1')).toBeUndefined()
  })

  it('caches the catalog so a second ensureChannel does not refetch', async () => {
    proxiedFetch.mockResolvedValue(catalog([{ id: 'uuid-1', title: 'Hydrate!' }]))
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    await provider.ensureChannel('caseoh_')
    expect(proxiedFetch).toHaveBeenCalledTimes(1)
  })

  it('caches an empty catalog (no custom rewards) without refetching', async () => {
    proxiedFetch.mockResolvedValue(catalog([]))
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'uuid-1')).toBeUndefined()
    expect(proxiedFetch).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed fetch, so a later connect retries', async () => {
    proxiedFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'uuid-1')).toBeUndefined()
    proxiedFetch.mockResolvedValueOnce(catalog([{ id: 'uuid-1', title: 'Hydrate!' }]))
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'uuid-1')).toBe('Hydrate!')
    expect(proxiedFetch).toHaveBeenCalledTimes(2)
  })

  it('survives a thrown fetch', async () => {
    proxiedFetch.mockRejectedValue(new Error('network down'))
    const provider = new TwitchRewardProvider()
    await provider.ensureChannel('caseoh_')
    expect(provider.resolve('caseoh_', 'uuid-1')).toBeUndefined()
  })
})
