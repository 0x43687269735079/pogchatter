import { describe, expect, it, vi } from 'vitest'
import { ManagedAuthProvider } from '@main/sources/twitch/ManagedAuthProvider'
import type { TwitchTokens } from '@main/sources/twitch/twitchAuth'

function tokens(accessToken: string): TwitchTokens {
  return {
    accessToken,
    refreshToken: 'rt',
    obtainmentTimestamp: 1_700_000_000_000,
    expiresIn: 14_400,
    scopes: ['chat:read', 'chat:edit'],
    userId: 'u1',
    userName: 'me'
  }
}

describe('ManagedAuthProvider.refreshAccessTokenForIntent', () => {
  it('forces a refresh through the manager and returns the refreshed token', async () => {
    let current = tokens('stale')
    const forceRefresh = vi.fn(async () => {
      current = tokens('fresh')
    })
    const provider = new ManagedAuthProvider(
      'client-id',
      vi.fn().mockResolvedValue(undefined),
      () => current,
      forceRefresh
    )
    const refreshed = await provider.refreshAccessTokenForIntent()
    expect(forceRefresh).toHaveBeenCalledTimes(1)
    expect(refreshed.accessToken).toBe('fresh')
    expect(refreshed.userId).toBe('u1')
  })

  it('throws when the forced refresh ends in a logout', async () => {
    let current: TwitchTokens | undefined = tokens('revoked')
    const provider = new ManagedAuthProvider(
      'client-id',
      vi.fn().mockResolvedValue(undefined),
      () => current,
      vi.fn(async () => {
        current = undefined
      })
    )
    await expect(provider.refreshAccessTokenForIntent()).rejects.toThrow(
      'Twitch token refresh failed — log in to Twitch again'
    )
  })
})
