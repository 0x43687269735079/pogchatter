import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthStore } from '@main/auth/AuthStore'
import { TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import { TwitchAuthRejectedError, type TwitchTokens } from '@main/sources/twitch/twitchAuth'

// Mock the token-endpoint boundary; the manager's refresh/login/logout logic stays real.
const twitchAuth = vi.hoisted(() => ({
  refreshTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollDeviceToken: vi.fn()
}))

vi.mock('@main/sources/twitch/twitchAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/sources/twitch/twitchAuth')>()
  return {
    ...actual,
    refreshTokens: twitchAuth.refreshTokens,
    requestDeviceCode: twitchAuth.requestDeviceCode,
    pollDeviceToken: twitchAuth.pollDeviceToken
  }
})

// Helix GETs go through proxiedFetch; mock it so helixFetch's recovery can be exercised offline.
const proxiedFetch = vi.hoisted(() => vi.fn())
vi.mock('@main/net/proxy', () => ({ proxiedFetch }))

function makeTokens(overrides: Partial<TwitchTokens> = {}): TwitchTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    obtainmentTimestamp: Date.now(),
    expiresIn: 14_400,
    scopes: ['chat:read'],
    userId: '42',
    userName: 'somestreamer',
    ...overrides
  }
}

function expiredTokens(): TwitchTokens {
  return makeTokens({ obtainmentTimestamp: Date.now() - 20_000_000 })
}

function fakeStore(initial?: TwitchTokens): { store: AuthStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  if (initial !== undefined) {
    data.set('twitch', initial)
  }
  const store = {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value)
    },
    delete: (key: string) => {
      data.delete(key)
    }
  } as unknown as AuthStore
  return { store, data }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('helixFetch (S2-3)', () => {
  it('retries once with a fresh token after a 401 from a revoked-but-unexpired token', async () => {
    const { store } = fakeStore(makeTokens())
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    twitchAuth.refreshTokens.mockResolvedValueOnce(makeTokens({ accessToken: 'access-2' }))
    const auths: Array<string | null> = []
    proxiedFetch
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        auths.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve({ status: 401, ok: false })
      })
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        auths.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve({ status: 200, ok: true })
      })

    const response = await manager.helixFetch('https://api.twitch.tv/helix/users')

    expect(response?.ok).toBe(true)
    expect(proxiedFetch).toHaveBeenCalledTimes(2)
    expect(auths).toEqual(['Bearer access-1', 'Bearer access-2'])
  })

  it('returns undefined without calling Helix when logged out', async () => {
    const { store } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())

    expect(await manager.helixFetch('https://api.twitch.tv/helix/users')).toBeUndefined()
    expect(proxiedFetch).not.toHaveBeenCalled()
  })

  it('does not force recovery for a non-auth non-OK response', async () => {
    const { store } = fakeStore(makeTokens())
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    proxiedFetch.mockResolvedValueOnce({ status: 500, ok: false })

    const response = await manager.helixFetch('https://api.twitch.tv/helix/users')

    expect(response?.status).toBe(500)
    expect(proxiedFetch).toHaveBeenCalledTimes(1)
    expect(twitchAuth.refreshTokens).not.toHaveBeenCalled()
  })
})

describe('ensureValid', () => {
  it('keeps the tokens and the store on a transient refresh failure, then retries', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.refreshTokens.mockRejectedValueOnce(new Error('fetch failed'))

    await manager.ensureValid()

    expect(manager.isLoggedIn).toBe(true)
    expect(data.get('twitch')).toBeDefined()
    expect(onChange).not.toHaveBeenCalled()

    const refreshed = makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    twitchAuth.refreshTokens.mockResolvedValueOnce(refreshed)
    await manager.ensureValid()

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(2)
    expect(data.get('twitch')).toEqual(refreshed)
    expect(manager.isLoggedIn).toBe(true)
  })

  it('clears the login, the store, and fires onChange when Twitch rejects the refresh token', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.refreshTokens.mockRejectedValueOnce(new TwitchAuthRejectedError('rejected (400)'))

    await manager.ensureValid()

    expect(manager.isLoggedIn).toBe(false)
    expect(data.has('twitch')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('persists a routine refresh without firing onChange', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const refreshed = makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    twitchAuth.refreshTokens.mockResolvedValueOnce(refreshed)

    await manager.ensureValid()

    expect(await manager.accessToken()).toBe('access-2')
    expect(data.get('twitch')).toEqual(refreshed)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shares one refresh across concurrent callers', async () => {
    const { store } = fakeStore(expiredTokens())
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const first = manager.ensureValid()
    const second = manager.ensureValid()
    gate.resolve(makeTokens({ accessToken: 'access-2' }))
    await Promise.all([first, second])

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(1)
  })
})

describe('logout during an in-flight refresh', () => {
  it('wins over a refresh that resolves afterwards — credentials are not re-persisted', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const refreshing = manager.ensureValid()
    manager.logout()
    expect(onChange).toHaveBeenCalledTimes(1)

    gate.resolve(makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' }))
    await refreshing

    expect(manager.isLoggedIn).toBe(false)
    expect(data.has('twitch')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('suppresses a definitive rejection that lands after the logout', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const refreshing = manager.ensureValid()
    manager.logout()
    gate.reject(new TwitchAuthRejectedError('rejected (400)'))
    await refreshing

    expect(manager.isLoggedIn).toBe(false)
    expect(data.has('twitch')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('handleAuthFailure', () => {
  it('does nothing when logged out', async () => {
    const { store } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())

    await manager.handleAuthFailure()

    expect(twitchAuth.refreshTokens).not.toHaveBeenCalled()
  })

  it('shares one forced refresh across concurrent failures and stays logged in on success', async () => {
    const { store, data } = fakeStore(makeTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const columnA = manager.handleAuthFailure()
    const columnB = manager.handleAuthFailure()
    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(1)

    const refreshed = makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    gate.resolve(refreshed)
    await Promise.all([columnA, columnB])

    expect(manager.isLoggedIn).toBe(true)
    expect(data.get('twitch')).toEqual(refreshed)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('joins an ensureValid-initiated refresh instead of spending the refresh token twice', async () => {
    const { store } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const refreshing = manager.ensureValid()
    const failure = manager.handleAuthFailure()
    gate.resolve(makeTokens({ accessToken: 'access-2' }))
    await Promise.all([refreshing, failure])

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(1)
    expect(manager.isLoggedIn).toBe(true)
  })

  it('requires re-login only when a recently COMPLETED refresh still fails', async () => {
    const { store, data } = fakeStore(makeTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.refreshTokens.mockResolvedValueOnce(makeTokens({ accessToken: 'access-2' }))

    await manager.handleAuthFailure()
    expect(manager.isLoggedIn).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)

    await manager.handleAuthFailure()

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(1)
    expect(manager.isLoggedIn).toBe(false)
    expect(data.has('twitch')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('keeps the login through a transient forced-refresh failure and retries later', async () => {
    const { store, data } = fakeStore(makeTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.refreshTokens.mockRejectedValueOnce(new Error('fetch failed'))

    await manager.handleAuthFailure()

    expect(manager.isLoggedIn).toBe(true)
    expect(data.get('twitch')).toBeDefined()
    expect(onChange).not.toHaveBeenCalled()

    const refreshed = makeTokens({ accessToken: 'access-2' })
    twitchAuth.refreshTokens.mockResolvedValueOnce(refreshed)
    await manager.handleAuthFailure()

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(2)
    expect(manager.isLoggedIn).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('clears the login with a single onChange when the forced refresh is rejected', async () => {
    const { store, data } = fakeStore(makeTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.refreshTokens.mockRejectedValueOnce(new TwitchAuthRejectedError('rejected (401)'))

    await manager.handleAuthFailure()

    expect(manager.isLoggedIn).toBe(false)
    expect(data.has('twitch')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('reconnects once after joining a routine refresh that rotated the token (S2-2)', async () => {
    const { store } = fakeStore(expiredTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    // A routine (expiry-driven) refresh is in flight; it rotates the token but does not reconnect.
    const refreshing = manager.ensureValid()
    // A source's auth failure joins that refresh instead of spending the refresh token again.
    const failure = manager.handleAuthFailure()
    gate.resolve(makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' }))
    await Promise.all([refreshing, failure])

    expect(twitchAuth.refreshTokens).toHaveBeenCalledTimes(1)
    // Without the reconnect, the failed source would stay disconnected despite fresh credentials.
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires onChange once across concurrent forced failures that share a refresh (S2-2)', async () => {
    const { store } = fakeStore(makeTokens())
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    const columnA = manager.handleAuthFailure()
    const columnB = manager.handleAuthFailure()
    gate.resolve(makeTokens({ accessToken: 'access-2', refreshToken: 'refresh-2' }))
    await Promise.all([columnA, columnB])

    // The owner and the joiner observe the same rotated token — exactly one reconnect, not two.
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('login', () => {
  const device = {
    device_code: 'device-code',
    user_code: 'ABCDEFGH',
    verification_uri: 'https://www.twitch.tv/activate',
    expires_in: 30,
    interval: 1
  }

  it('a login completing during an in-flight refresh is not overwritten by it (S2-1)', async () => {
    const { store, data } = fakeStore(expiredTokens())
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    const gate = deferred<TwitchTokens>()
    twitchAuth.refreshTokens.mockReturnValueOnce(gate.promise)

    // A routine refresh of the stored (expired) token is in flight.
    const refreshing = manager.ensureValid()

    // The user logs in to a different account before that refresh resolves.
    twitchAuth.requestDeviceCode.mockResolvedValueOnce({ ...device, interval: 0 })
    const fresh = makeTokens({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      userId: '99',
      userName: 'newaccount'
    })
    twitchAuth.pollDeviceToken.mockResolvedValueOnce(fresh)
    await manager.login(() => {})
    expect(manager.userName).toBe('newaccount')

    // The stale refresh now resolves — its commit must be superseded, not overwrite the new login.
    gate.resolve(
      makeTokens({ accessToken: 'stale-refreshed', userId: '42', userName: 'somestreamer' })
    )
    await refreshing

    expect(manager.userName).toBe('newaccount')
    expect(data.get('twitch')).toEqual(fresh)
  })

  it('keeps polling through transient poll failures', async () => {
    vi.useFakeTimers()
    const { store, data } = fakeStore()
    const onChange = vi.fn()
    const manager = new TwitchAuthManager('client-id', store, onChange)
    twitchAuth.requestDeviceCode.mockResolvedValueOnce(device)
    const granted = makeTokens()
    twitchAuth.pollDeviceToken
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce(granted)

    const onPrompt = vi.fn()
    const login = manager.login(onPrompt)
    await vi.advanceTimersByTimeAsync(3000)
    await login

    expect(onPrompt).toHaveBeenCalledWith(device)
    expect(twitchAuth.pollDeviceToken).toHaveBeenCalledTimes(3)
    expect(manager.isLoggedIn).toBe(true)
    expect(data.get('twitch')).toEqual(granted)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('surfaces a denial as a terminal failure', async () => {
    vi.useFakeTimers()
    const { store } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    twitchAuth.requestDeviceCode.mockResolvedValueOnce(device)
    twitchAuth.pollDeviceToken.mockRejectedValueOnce(
      new TwitchAuthRejectedError('Twitch authorization failed: access_denied')
    )

    const outcome = manager.login(vi.fn()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)

    const error = await outcome
    expect(error).toBeInstanceOf(TwitchAuthRejectedError)
    expect(manager.isLoggedIn).toBe(false)
  })

  it('fails with a timeout when the device code expires unapproved', async () => {
    vi.useFakeTimers()
    const { store } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    twitchAuth.requestDeviceCode.mockResolvedValueOnce({ ...device, expires_in: 3 })
    twitchAuth.pollDeviceToken.mockResolvedValue('pending')

    const outcome = manager.login(vi.fn()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(4000)

    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Twitch login timed out')
    expect(manager.isLoggedIn).toBe(false)
  })
})

describe('TwitchAuthManager.login supersession', () => {
  const device = {
    device_code: 'dev-1',
    user_code: 'ABCDEFGH',
    verification_uri: 'https://www.twitch.tv/activate',
    expires_in: 30,
    interval: 1
  }

  it('lets a second login attempt take over from an abandoned one', async () => {
    vi.useFakeTimers()
    const { store, data } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    const granted = makeTokens()
    twitchAuth.requestDeviceCode
      .mockResolvedValueOnce(device)
      .mockResolvedValueOnce({ ...device, device_code: 'dev-2', user_code: 'ZYXWVUTS' })
    // First attempt polls forever (user closed the dialog); second gets granted.
    twitchAuth.pollDeviceToken.mockImplementation(async (_id: string, code: string) =>
      code === 'dev-2' ? granted : 'pending'
    )

    const first = manager.login(vi.fn()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    const secondPrompt = vi.fn()
    const second = manager.login(secondPrompt)
    await vi.advanceTimersByTimeAsync(2000)

    await second
    expect(secondPrompt).toHaveBeenCalled()
    expect(manager.isLoggedIn).toBe(true)
    expect(data.get('twitch')).toEqual(granted)
    const error = await first
    expect((error as Error).message).toContain('superseded')
  })

  it('logout abandons a pending device-code poll', async () => {
    vi.useFakeTimers()
    const { store } = fakeStore()
    const manager = new TwitchAuthManager('client-id', store, vi.fn())
    twitchAuth.requestDeviceCode.mockResolvedValueOnce(device)
    twitchAuth.pollDeviceToken.mockResolvedValue('pending')

    const outcome = manager.login(vi.fn()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    manager.logout()
    await vi.advanceTimersByTimeAsync(1000)

    const error = await outcome
    expect((error as Error).message).toContain('superseded')
    expect(manager.isLoggedIn).toBe(false)
  })
})
