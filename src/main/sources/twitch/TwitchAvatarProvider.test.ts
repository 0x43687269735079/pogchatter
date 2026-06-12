import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@twurple/api'
import { TwitchAvatarProvider } from '@main/sources/twitch/TwitchAvatarProvider'

// Mock the Helix boundary: a fake ApiClient whose `users.getUsersByNames` records each batch.
const getUsersByNames = vi.fn()
const api = { users: { getUsersByNames } } as unknown as ApiClient

function helixUser(login: string): { name: string; profilePictureUrl: string } {
  return { name: login, profilePictureUrl: `https://cdn/${login}.png` }
}

beforeEach(() => {
  vi.useFakeTimers()
  getUsersByNames.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TwitchAvatarProvider', () => {
  it('batches unseen logins into one Helix call and caches the results', async () => {
    getUsersByNames.mockResolvedValue([helixUser('alice'), helixUser('bob')])
    const provider = new TwitchAvatarProvider(() => api)
    expect(provider.resolve('alice')).toBeUndefined()
    expect(provider.resolve('bob')).toBeUndefined()
    // A repeat before the flush doesn't queue the login twice.
    expect(provider.resolve('alice')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(1)
    expect(getUsersByNames).toHaveBeenCalledWith(['alice', 'bob'])
    expect(provider.resolve('alice')).toBe('https://cdn/alice.png')
    expect(provider.resolve('bob')).toBe('https://cdn/bob.png')
    // Cached logins never re-queue a lookup.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(1)
  })

  it("splits a queue beyond Helix's 100-login limit across calls", async () => {
    getUsersByNames.mockResolvedValue([])
    const provider = new TwitchAvatarProvider(() => api)
    for (let i = 0; i < 150; i += 1) {
      provider.resolve(`user${i}`)
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(1)
    expect(getUsersByNames.mock.calls[0]?.[0]).toHaveLength(100)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(2)
    expect(getUsersByNames.mock.calls[1]?.[0]).toHaveLength(50)
  })

  it('drops a failed batch so the logins retry with their next message', async () => {
    getUsersByNames.mockRejectedValueOnce(new Error('helix down'))
    getUsersByNames.mockResolvedValueOnce([helixUser('alice')])
    const provider = new TwitchAvatarProvider(() => api)
    provider.resolve('alice')
    await vi.advanceTimersByTimeAsync(2_000)
    // Still unresolved — this re-queues the login, like the chatter's next message would.
    expect(provider.resolve('alice')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(2)
    expect(provider.resolve('alice')).toBe('https://cdn/alice.png')
  })

  it('never calls Helix without an API client (logged out)', async () => {
    const provider = new TwitchAvatarProvider(() => undefined)
    provider.resolve('alice')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getUsersByNames).not.toHaveBeenCalled()
  })

  it('stop() cancels the pending batch but keeps the cache for a reconnect', async () => {
    getUsersByNames.mockResolvedValue([helixUser('alice')])
    const provider = new TwitchAvatarProvider(() => api)
    provider.resolve('alice')
    await vi.advanceTimersByTimeAsync(2_000)
    provider.resolve('bob')
    provider.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getUsersByNames).toHaveBeenCalledTimes(1)
    expect(provider.resolve('alice')).toBe('https://cdn/alice.png')
  })

  it('evicts the oldest cached avatars past the cap (FIFO)', async () => {
    getUsersByNames.mockResolvedValueOnce(
      Array.from({ length: 2000 }, (_, i) => helixUser(`user${i}`))
    )
    const provider = new TwitchAvatarProvider(() => api)
    provider.resolve('user0')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(provider.resolve('user0')).toBe('https://cdn/user0.png')
    getUsersByNames.mockResolvedValueOnce([helixUser('newcomer')])
    provider.resolve('newcomer')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(provider.resolve('newcomer')).toBe('https://cdn/newcomer.png')
    // The oldest entry fell out; it re-queues whenever that chatter speaks again.
    expect(provider.resolve('user0')).toBeUndefined()
    expect(provider.resolve('user1')).toBe('https://cdn/user1.png')
  })
})

describe('TwitchAvatarProvider onResolved', () => {
  it('announces each resolved login so buffered rows can back-fill', async () => {
    getUsersByNames.mockResolvedValue([
      helixUser('alice'),
      { name: 'noavatar', profilePictureUrl: '' }
    ])
    const resolved = vi.fn()
    const provider = new TwitchAvatarProvider(() => api, resolved)
    provider.resolve('alice')
    provider.resolve('noavatar')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(resolved).toHaveBeenCalledWith('alice', 'https://cdn/alice.png')
  })
})
