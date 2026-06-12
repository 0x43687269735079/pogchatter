import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pollDeviceToken,
  refreshTokens,
  TwitchAuthRejectedError,
  type TwitchTokens
} from '@main/sources/twitch/twitchAuth'

// Mock the network boundary; the classification and token-shaping logic stays real.
const net = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('@main/net/proxy', () => ({ proxiedFetch: net.fetch }))

function jsonResponse(
  status: number,
  body: unknown
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const previous: TwitchTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  obtainmentTimestamp: 1_000,
  expiresIn: 14_400,
  scopes: ['chat:read', 'chat:edit'],
  userId: '42',
  userName: 'somestreamer'
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('refreshTokens', () => {
  it('returns rotated tokens with identity carried over, without a VALIDATE round-trip', async () => {
    net.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        scope: ['chat:read']
      })
    )

    const tokens = await refreshTokens('client-id', previous)

    expect(net.fetch).toHaveBeenCalledTimes(1)
    expect(tokens.accessToken).toBe('access-2')
    expect(tokens.refreshToken).toBe('refresh-2')
    expect(tokens.scopes).toEqual(['chat:read'])
    expect(tokens.userId).toBe('42')
    expect(tokens.userName).toBe('somestreamer')
  })

  it('falls back to the previous scopes when the response omits them', async () => {
    net.fetch.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    )

    const tokens = await refreshTokens('client-id', previous)

    expect(tokens.scopes).toEqual(['chat:read', 'chat:edit'])
  })

  it.each([400, 401])('classifies a %i as a definitive rejection', async (status) => {
    net.fetch.mockResolvedValueOnce(jsonResponse(status, { message: 'Invalid refresh token' }))

    await expect(refreshTokens('client-id', previous)).rejects.toBeInstanceOf(
      TwitchAuthRejectedError
    )
  })

  it.each([429, 500, 503])('classifies a %i as transient', async (status) => {
    net.fetch.mockResolvedValueOnce(jsonResponse(status, {}))

    const error = await refreshTokens('client-id', previous).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(TwitchAuthRejectedError)
  })

  it('propagates a network rejection as transient', async () => {
    net.fetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    const error = await refreshTokens('client-id', previous).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(TwitchAuthRejectedError)
  })
})

describe('pollDeviceToken', () => {
  it.each(['authorization_pending', 'slow_down'])('keeps polling on %s', async (message) => {
    net.fetch.mockResolvedValueOnce(jsonResponse(400, { message }))

    await expect(pollDeviceToken('client-id', 'device-code', [])).resolves.toBe('pending')
  })

  it('classifies a denial as a definitive rejection', async () => {
    net.fetch.mockResolvedValueOnce(jsonResponse(400, { message: 'access_denied' }))

    await expect(pollDeviceToken('client-id', 'device-code', [])).rejects.toBeInstanceOf(
      TwitchAuthRejectedError
    )
  })

  it('classifies a server error as transient', async () => {
    net.fetch.mockResolvedValueOnce(jsonResponse(503, {}))

    const error = await pollDeviceToken('client-id', 'device-code', []).catch(
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(TwitchAuthRejectedError)
  })

  it('builds tokens from the grant plus a VALIDATE identity lookup', async () => {
    net.fetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 14_400,
          scope: ['chat:read']
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { user_id: '42', login: 'somestreamer' }))

    const tokens = await pollDeviceToken('client-id', 'device-code', ['chat:read'])

    expect(tokens).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scopes: ['chat:read'],
      userId: '42',
      userName: 'somestreamer'
    })
  })
})
