import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('youtubei.js', () => ({
  Innertube: { create: vi.fn() }
}))

import { Innertube } from 'youtubei.js'
import type { AuthStore } from '@main/auth/AuthStore'
import { extractYtInitialData, YouTubeAuthManager } from '@main/sources/youtube/YouTubeAuthManager'

const create = vi.mocked(Innertube.create)

class FakeStore {
  readonly #data = new Map<string, unknown>()
  get<T>(key: string): T | undefined {
    return this.#data.get(key) as T | undefined
  }
  set(key: string, value: unknown): void {
    this.#data.set(key, value)
  }
  delete(key: string): void {
    this.#data.delete(key)
  }
}

function session(loggedIn: boolean): unknown {
  return { session: { logged_in: loggedIn } }
}

/** A fake account-switcher item exposing only the fields the manager reads. */
function accountItem(opts: {
  name: string
  handle?: string
  selected: boolean
  pageId?: string
}): unknown {
  return {
    has_channel: true,
    is_selected: opts.selected,
    account_name: { toString: () => opts.name },
    channel_handle: { toString: () => opts.handle ?? '' },
    account_photo: [{ url: `http://img/${opts.name}`, width: 88 }],
    endpoint:
      opts.pageId !== undefined
        ? { payload: { supportedTokens: [{ pageIdToken: { pageId: opts.pageId } }] } }
        : { payload: {} }
  }
}

/** A logged-in instance whose account switcher returns `accounts`. */
function instanceWith(accounts: unknown[]): unknown {
  return {
    session: { logged_in: true },
    account: { getInfo: vi.fn().mockResolvedValue(accounts) }
  }
}

function lastCreateOptions(): { on_behalf_of_user?: string } {
  return (create.mock.calls.at(-1)?.[0] ?? {}) as { on_behalf_of_user?: string }
}

function newManager(store: FakeStore): YouTubeAuthManager {
  return new YouTubeAuthManager(
    store as unknown as AuthStore,
    'UA',
    () => undefined,
    () => {}
  )
}

/** A manager with an observable `onChange` (fired on login/logout/channel-switch and auth recovery). */
function newManagerWith(store: FakeStore, onChange: () => void): YouTubeAuthManager {
  return new YouTubeAuthManager(store as unknown as AuthStore, 'UA', () => undefined, onChange)
}

describe('YouTubeAuthManager transactional cookie updates', () => {
  beforeEach(() => {
    create.mockReset()
  })

  it('logs in and persists cookies on a valid paste', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(session(true) as never)

    await manager.setCookies('SAPISID=abc; SID=xyz')

    expect(manager.isLoggedIn).toBe(true)
    expect(store.get('youtube')).toEqual({ cookie: 'SAPISID=abc; SID=xyz' })
  })

  it('strips a pasted "Cookie:" header prefix so the first cookie is not mangled', () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(session(true) as never)

    // Pasting the whole header (with "Cookie: ") must not turn the first cookie into a "Cookie: YSC"
    // entry — the stored jar should be clean.
    return manager.setCookies('Cookie: YSC=abc; SID=xyz').then(() => {
      expect(store.get('youtube')).toEqual({ cookie: 'YSC=abc; SID=xyz' })
    })
  })

  it('keeps the working session and stored cookies when an update fails validation', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(session(true) as never)
    await manager.setCookies('SAPISID=good; SID=good')
    const stored = store.get('youtube')

    create.mockResolvedValueOnce(session(false) as never)
    await expect(manager.setCookies('SID=bad')).rejects.toThrow()

    expect(manager.isLoggedIn).toBe(true)
    expect(store.get('youtube')).toEqual(stored)
  })

  it('rejects an empty cookie blob without creating a session', async () => {
    const store = new FakeStore()
    const manager = newManager(store)

    await expect(manager.setCookies('   ')).rejects.toThrow()

    expect(manager.isLoggedIn).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('attaches the cookie jar only to YouTube hosts', async () => {
    const store = new FakeStore()
    let captured: typeof fetch | undefined
    create.mockImplementationOnce((options) => {
      captured = (options as { fetch: typeof fetch }).fetch
      return Promise.resolve(session(true) as never)
    })
    await newManager(store).setCookies('SAPISID=abc; SID=xyz')

    const wrappedFetch = captured
    if (wrappedFetch === undefined) {
      throw new Error('Innertube.create was not given a fetch implementation')
    }

    const seen: Array<{ url: string; cookie: string | null }> = []
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') })
      return Promise.resolve(new Response('', { status: 200 }))
    })
    try {
      await wrappedFetch('https://www.youtube.com/youtubei/v1/next')
      await wrappedFetch('https://evil.example.com/collect')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(seen[0]?.cookie).toContain('SAPISID=abc')
    expect(seen[1]?.cookie).toBeNull()
  })

  it('does not merge Set-Cookie when the final response host is not YouTube', async () => {
    const store = new FakeStore()
    let captured: typeof fetch | undefined
    create.mockImplementationOnce((options) => {
      captured = (options as { fetch: typeof fetch }).fetch
      return Promise.resolve(session(true) as never)
    })
    await newManager(store).setCookies('SAPISID=abc; SID=xyz')
    const before = store.get('youtube')

    const wrappedFetch = captured
    if (wrappedFetch === undefined) {
      throw new Error('Innertube.create was not given a fetch implementation')
    }
    // A YouTube request that redirects to a non-YouTube final URL returning Set-Cookie.
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        url: 'https://evil.example.com/landing',
        headers: { getSetCookie: () => ['INJECT=1; Path=/'] }
      } as never)
    )
    try {
      await wrappedFetch('https://www.youtube.com/youtubei/v1/next')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(store.get('youtube')).toEqual(before)
  })

  it('does not attach the cookie jar to an http (non-https) YouTube URL', async () => {
    const store = new FakeStore()
    let captured: typeof fetch | undefined
    create.mockImplementationOnce((options) => {
      captured = (options as { fetch: typeof fetch }).fetch
      return Promise.resolve(session(true) as never)
    })
    await newManager(store).setCookies('SAPISID=abc; SID=xyz')

    const wrappedFetch = captured
    if (wrappedFetch === undefined) {
      throw new Error('Innertube.create was not given a fetch implementation')
    }
    let cookie: string | null = 'unset'
    vi.stubGlobal('fetch', (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      cookie = new Headers(init?.headers).get('cookie')
      return Promise.resolve(new Response('', { status: 200 }))
    })
    try {
      // Same host, but cleartext — the cookie jar must not ride along over http.
      await wrappedFetch('http://www.youtube.com/youtubei/v1/next')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(cookie).toBeNull()
  })

  it('does not attach the cookie jar to youtu.be or youtube-nocookie.com (S2-7)', async () => {
    const store = new FakeStore()
    let captured: typeof fetch | undefined
    create.mockImplementationOnce((options) => {
      captured = (options as { fetch: typeof fetch }).fetch
      return Promise.resolve(session(true) as never)
    })
    await newManager(store).setCookies('SAPISID=abc; SID=xyz')

    const wrappedFetch = captured
    if (wrappedFetch === undefined) {
      throw new Error('Innertube.create was not given a fetch implementation')
    }

    const seen: Array<{ url: string; cookie: string | null }> = []
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') })
      return Promise.resolve(new Response('', { status: 200 }))
    })
    try {
      // A browser never sends youtube.com cookies to these domains, so neither may carry the jar.
      await wrappedFetch('https://youtu.be/abc')
      await wrappedFetch('https://www.youtube-nocookie.com/embed/abc')
      // accounts.youtube.com (cookie rotation) still receives the jar — it's a youtube.com subdomain.
      await wrappedFetch('https://accounts.youtube.com/RotateCookies')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(seen[0]?.cookie).toBeNull()
    expect(seen[1]?.cookie).toBeNull()
    expect(seen[2]?.cookie).toContain('SAPISID=abc')
  })

  it('does not merge Set-Cookie when the final response URL downgrades to http', async () => {
    const store = new FakeStore()
    let captured: typeof fetch | undefined
    create.mockImplementationOnce((options) => {
      captured = (options as { fetch: typeof fetch }).fetch
      return Promise.resolve(session(true) as never)
    })
    await newManager(store).setCookies('SAPISID=abc; SID=xyz')
    const before = store.get('youtube')

    const wrappedFetch = captured
    if (wrappedFetch === undefined) {
      throw new Error('Innertube.create was not given a fetch implementation')
    }
    // An https YouTube request whose final response URL is http (a downgrade) returning Set-Cookie.
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        url: 'http://www.youtube.com/landing',
        headers: { getSetCookie: () => ['INJECT=1; Path=/'] }
      } as never)
    )
    try {
      await wrappedFetch('https://www.youtube.com/youtubei/v1/next')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(store.get('youtube')).toEqual(before)
  })
})

describe('YouTubeAuthManager channel selection', () => {
  beforeEach(() => {
    create.mockReset()
    // selectChannel/setCookies never reach the network here, but stub fetch defensively.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('enumerates the account channels and defaults to the selected identity', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(
      instanceWith([
        accountItem({ name: 'Me', handle: '@me', selected: true }),
        accountItem({ name: 'Brand', handle: '@brand', selected: false, pageId: 'PAGE123' })
      ]) as never
    )

    await manager.setCookies('SAPISID=abc; SID=xyz')

    expect(manager.getChannels()).toEqual([
      { id: 'default', name: 'Me', handle: '@me', avatarUrl: 'http://img/Me' },
      { id: 'PAGE123', name: 'Brand', handle: '@brand', avatarUrl: 'http://img/Brand' }
    ])
    expect(manager.getSelectedId()).toBe('default')
    // The default identity needs no delegation.
    expect(lastCreateOptions().on_behalf_of_user).toBeUndefined()
  })

  it('switches to a brand channel via on_behalf_of_user and persists the choice', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(
      instanceWith([
        accountItem({ name: 'Me', selected: true }),
        accountItem({ name: 'Brand', selected: false, pageId: 'PAGE123' })
      ]) as never
    )
    await manager.setCookies('SAPISID=abc; SID=xyz')

    create.mockResolvedValueOnce(session(true) as never)
    await manager.selectChannel('PAGE123')

    expect(manager.getSelectedId()).toBe('PAGE123')
    expect(lastCreateOptions().on_behalf_of_user).toBe('PAGE123')
    expect(store.get('youtube')).toEqual({ cookie: 'SAPISID=abc; SID=xyz', channelId: 'PAGE123' })
  })

  it('rejects selecting a channel that is not on the account', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(
      instanceWith([accountItem({ name: 'Me', selected: true })]) as never
    )
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.selectChannel('NOPE')).rejects.toThrow()
    expect(manager.getSelectedId()).toBe('default')
  })

  it('restores the persisted channel selection on init', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz', channelId: 'PAGE123' })
    const manager = newManager(store)
    create
      .mockResolvedValueOnce(
        instanceWith([
          accountItem({ name: 'Me', selected: true }),
          accountItem({ name: 'Brand', selected: false, pageId: 'PAGE123' })
        ]) as never
      )
      .mockResolvedValueOnce(session(true) as never)

    await manager.init()

    expect(manager.getSelectedId()).toBe('PAGE123')
    expect(lastCreateOptions().on_behalf_of_user).toBe('PAGE123')
  })
})

/** A logged-in instance whose live-chat send resolves or rejects as given. */
function sendInstance(send: () => Promise<unknown>): unknown {
  return {
    session: { logged_in: true },
    account: { getInfo: vi.fn().mockResolvedValue([]) },
    getInfo: vi.fn().mockResolvedValue({
      livechat: { continuation: 'c' },
      basic_info: { channel_id: 'UCfallback' }
    }),
    actions: { execute: vi.fn(send) }
  }
}

/** A raw (parse: false) send_message response delivering `data`. */
function rawResponse(data: unknown): unknown {
  return { success: true, status_code: 200, data }
}

const AUTH_401 = new Error(
  'Request to https://www.youtube.com/youtubei/v1/live_chat/send_message failed with status code 401'
)

describe('YouTubeAuthManager send resilience', () => {
  beforeEach(() => {
    create.mockReset()
    // #recoverSend rotates cookies on a 401; stub fetch so it never hits the network.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends via the live-chat endpoint without getInfo when the channel id is known', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    const getInfo = vi.fn()
    const execute = vi.fn().mockResolvedValue(rawResponse({ actions: [{ addChatItemAction: {} }] }))
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      getInfo,
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await manager.sendMessage('vid12345678', 'UCxyz', 'hello')

    expect(getInfo).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(
      '/live_chat/send_message',
      expect.objectContaining({
        richMessage: { textSegments: [{ text: 'hello' }] },
        client: 'WEB',
        parse: false
      })
    )
  })

  it('reports a held (dimmed) message as not posted instead of faking success', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    // YouTube held the message: instead of the add-chat-item echo it dims the optimistic copy.
    const execute = vi
      .fn()
      .mockResolvedValue(rawResponse({ actions: [{ dimChatItemAction: { itemId: 'x' } }] }))
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', 'UCxyz', 'hello')).rejects.toThrow(
      /held your message/
    )
    // A held message is not an auth failure → no rebuild/retry.
    expect(execute).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('treats an unrecognized but error-free response as posted (no duplicate-inviting failure)', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    // Response-shape drift: no recognizable echo, but no hold and no error either.
    const execute = vi
      .fn()
      .mockResolvedValue(rawResponse({ actions: [{ someNewExperimentCommand: {} }] }))
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', 'UCxyz', 'hello')).resolves.toBeUndefined()
  })

  it("surfaces an explicit error payload with YouTube's own message", async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    const execute = vi
      .fn()
      .mockResolvedValue(rawResponse({ error: { code: 403, message: 'Slow mode is enabled' } }))
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', 'UCxyz', 'hello')).rejects.toThrow(
      /Slow mode is enabled/
    )
  })

  it('reports a message-less error payload as unconfirmed delivery, warning before a resend', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    const execute = vi.fn().mockResolvedValue(rawResponse({ error: {} }))
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', 'UCxyz', 'hello')).rejects.toThrow(
      /unconfirmed.*check the chat/
    )
  })

  it('rebuilds the session and retries once when a send is rejected with 401', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create
      .mockResolvedValueOnce(sendInstance(() => Promise.reject(AUTH_401)) as never)
      .mockResolvedValueOnce(
        sendInstance(() =>
          Promise.resolve(rawResponse({ actions: [{ addChatItemAction: {} }] }))
        ) as never
      )
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', undefined, 'hello')).resolves.toBeUndefined()
    // One create for login, one for the post-401 rebuild.
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('reconnects open readers (onChange) after a send recovers from a 401', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)
    create
      .mockResolvedValueOnce(sendInstance(() => Promise.reject(AUTH_401)) as never)
      .mockResolvedValueOnce(
        sendInstance(() =>
          Promise.resolve(rawResponse({ actions: [{ addChatItemAction: {} }] }))
        ) as never
      )
    await manager.setCookies('SAPISID=abc; SID=xyz')
    onChange.mockClear() // setCookies fired onChange once

    await manager.sendMessage('vid12345678', undefined, 'hello')

    // The rebuilt instance superseded the one open readers hold, so they reconnect onto it.
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect readers when a send succeeds without recovery', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)
    create.mockResolvedValueOnce(
      sendInstance(() =>
        Promise.resolve(rawResponse({ actions: [{ addChatItemAction: {} }] }))
      ) as never
    )
    await manager.setCookies('SAPISID=abc; SID=xyz')
    onChange.mockClear()

    await manager.sendMessage('vid12345678', 'UCxyz', 'hello')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not retry a non-auth send failure', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create.mockResolvedValueOnce(sendInstance(() => Promise.reject(new Error('boom'))) as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', undefined, 'hello')).rejects.toThrow('boom')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('logs out when a send still fails after rebuilding (session expired)', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create
      .mockResolvedValueOnce(sendInstance(() => Promise.reject(AUTH_401)) as never)
      .mockResolvedValueOnce(sendInstance(() => Promise.reject(AUTH_401)) as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.sendMessage('vid12345678', undefined, 'hello')).rejects.toThrow(
      /log in to YouTube/
    )
    expect(manager.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toBeUndefined()
  })

  it('discards a restored session whose cookies no longer authenticate', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz' })
    const manager = newManager(store)
    // Restore validates, fails auth, rotates once, and retries — both attempts reject.
    create.mockResolvedValue({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockRejectedValue(AUTH_401) }
    } as never)

    await manager.init()

    expect(manager.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toBeUndefined()
  })

  it('discards stored cookies when restore builds a session that is not logged in (S2-8)', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz' })
    const manager = newManager(store)
    // The cookies build a session but it isn't signed in (incomplete/expired identity cookies) —
    // no rotating-token to refresh, so restore must discard rather than keep retrying every launch.
    create.mockResolvedValue(session(false) as never)

    await manager.init()

    expect(manager.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toBeUndefined()
  })

  it('keeps the stored cookies when restore fails transiently, so a later launch can log in', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz' })
    const offline = newManager(store)
    // App starts without network: the session build itself fails, not the auth.
    create.mockRejectedValueOnce(new Error('fetch failed'))

    await offline.init()

    expect(offline.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toEqual({ cookie: 'SAPISID=abc; SID=xyz' })

    // Next launch with the network back: the same stored cookies restore the session.
    const relaunched = newManager(store)
    create.mockResolvedValueOnce(
      instanceWith([accountItem({ name: 'Me', selected: true })]) as never
    )
    await relaunched.init()
    expect(relaunched.isLoggedIn).toBe(true)
  })
})

describe('YouTubeAuthManager.runMessageAction', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function menuResponse(items: unknown[]): unknown {
    return { data: { liveChatItemContextMenuSupportedRenderers: { menuRenderer: { items } } } }
  }

  /** A viewer Block item shaped like the real capture: the action sits on the dialog's confirm button. */
  function blockItem(dialog: unknown): unknown {
    return {
      menuNavigationItemRenderer: {
        text: { runs: [{ text: 'Block' }] },
        icon: { iconType: 'NOT_INTERESTED' },
        navigationEndpoint: { commandMetadata: {}, confirmDialogEndpoint: dialog }
      }
    }
  }

  async function managerWith(execute: ReturnType<typeof vi.fn>): Promise<YouTubeAuthManager> {
    const manager = newManager(new FakeStore())
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')
    return manager
  }

  it("runs Block via the confirm dialog's confirm button endpoint (live_chat/moderate)", async () => {
    const dialog = {
      content: {
        confirmDialogRenderer: {
          confirmButton: {
            buttonRenderer: {
              serviceEndpoint: { moderateLiveChatEndpoint: { params: 'block-token' } }
            }
          }
        }
      }
    }
    const execute = vi.fn().mockResolvedValue(menuResponse([blockItem(dialog)]))
    const manager = await managerWith(execute)

    await manager.runMessageAction('menu-token', 'NOT_INTERESTED')

    expect(execute).toHaveBeenCalledWith('live_chat/moderate', {
      params: 'block-token',
      parse: false
    })
  })

  it('refuses with a clear error when the confirm dialog has no confirm button', async () => {
    const execute = vi.fn().mockResolvedValue(menuResponse([blockItem({ content: {} })]))
    const manager = await managerWith(execute)

    await expect(manager.runMessageAction('menu-token', 'NOT_INTERESTED')).rejects.toThrow(
      /changed how this action works/
    )
    // Only the menu fetch ran — the broken endpoint was never executed.
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the session and retries once when a moderation action is rejected with 401', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    const dialog = {
      content: {
        confirmDialogRenderer: {
          confirmButton: {
            buttonRenderer: {
              serviceEndpoint: { moderateLiveChatEndpoint: { params: 'block-token' } }
            }
          }
        }
      }
    }
    // Stale rotating token → the first menu fetch 401s; after rotate+rebuild the retry succeeds.
    const retryExecute = vi
      .fn()
      .mockResolvedValueOnce(menuResponse([blockItem(dialog)]))
      .mockResolvedValueOnce({ data: {} })
    create
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: retryExecute }
      } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.runMessageAction('menu-token', 'NOT_INTERESTED')).resolves.toBeUndefined()
    // One create for login, one for the post-401 rebuild.
    expect(create).toHaveBeenCalledTimes(2)
    expect(retryExecute).toHaveBeenCalledWith('live_chat/moderate', {
      params: 'block-token',
      parse: false
    })
  })

  it('logs out when a moderation action still fails auth after rebuilding', async () => {
    const store = new FakeStore()
    const manager = newManager(store)
    create
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.runMessageAction('menu-token', 'NOT_INTERESTED')).rejects.toThrow(
      /log in to YouTube/
    )
    expect(manager.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toBeUndefined()
  })
})

describe('YouTubeAuthManager.getMessageActions', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function menuResponse(items: unknown[]): unknown {
    return { data: { liveChatItemContextMenuSupportedRenderers: { menuRenderer: { items } } } }
  }
  const removeItem = {
    menuServiceItemRenderer: {
      text: { runs: [{ text: 'Remove' }] },
      icon: { iconType: 'DELETE' },
      serviceEndpoint: { moderateLiveChatEndpoint: { params: 'p' } }
    }
  }

  function instanceExecuting(execute: ReturnType<typeof vi.fn>): unknown {
    return {
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    }
  }

  it('recovers from a stale-session 401 on the menu fetch and returns the parsed actions', async () => {
    const manager = newManager(new FakeStore())
    create
      .mockResolvedValueOnce(instanceExecuting(vi.fn().mockRejectedValue(AUTH_401)) as never)
      .mockResolvedValueOnce(
        instanceExecuting(vi.fn().mockResolvedValue(menuResponse([removeItem]))) as never
      )
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.getMessageActions('menu-token')).resolves.toMatchObject([{ id: 'DELETE' }])
    // One create for login, one for the post-401 rebuild.
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('returns [] without logging out when the menu stays 401 after a rebuild', async () => {
    const manager = newManager(new FakeStore())
    create.mockResolvedValue(instanceExecuting(vi.fn().mockRejectedValue(AUTH_401)) as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    // A best-effort background read degrades to [] — it must never sign the moderator out.
    await expect(manager.getMessageActions('menu-token')).resolves.toEqual([])
    expect(manager.isLoggedIn).toBe(true)
  })

  it('returns [] when logged out', async () => {
    await expect(newManager(new FakeStore()).getMessageActions('menu-token')).resolves.toEqual([])
  })

  it('reconnects open readers after the menu recovery rebuilds the session', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)
    create
      .mockResolvedValueOnce(instanceExecuting(vi.fn().mockRejectedValue(AUTH_401)) as never)
      .mockResolvedValueOnce(
        instanceExecuting(vi.fn().mockResolvedValue(menuResponse([removeItem]))) as never
      )
    await manager.setCookies('SAPISID=abc; SID=xyz')
    onChange.mockClear()

    await manager.getMessageActions('menu-token')

    // The rebuilt session must reach open readers, like the write-path recovery (S2-5).
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('YouTubeAuthManager.recoverReads', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rotates, rebuilds, and reconnects readers on a read auth failure', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)
    create
      .mockResolvedValueOnce(session(true) as never) // login
      .mockResolvedValueOnce(session(true) as never) // rebuild
    await manager.setCookies('SAPISID=abc; SID=xyz')
    onChange.mockClear()

    await manager.recoverReads()

    // login + rebuild = 2 creates; the rebuild reconnects open readers via onChange.
    expect(create).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('debounces repeated read recoveries so the single-use rotation is not hammered', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)
    create.mockResolvedValue(session(true) as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')
    onChange.mockClear()

    await manager.recoverReads()
    await manager.recoverReads() // within the debounce window → a no-op

    expect(create).toHaveBeenCalledTimes(2) // login + a single rebuild
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when logged out', async () => {
    const onChange = vi.fn()
    const manager = newManagerWith(new FakeStore(), onChange)

    await manager.recoverReads()

    expect(create).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('YouTubeAuthManager.fetchLiveChatBootstrap', () => {
  beforeEach(() => {
    create.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function loggedInManager(): Promise<YouTubeAuthManager> {
    const manager = newManager(new FakeStore())
    create.mockResolvedValueOnce(session(true) as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')
    return manager
  }

  it('resolves to undefined instead of hanging when the bootstrap GET stalls past the timeout', async () => {
    const manager = await loggedInManager()
    vi.useFakeTimers()
    // A black-hole connection: never settles on its own, but honors the abort signal.
    vi.stubGlobal('fetch', (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    })
    try {
      const pending = manager.fetchLiveChatBootstrap('cont-token', 'vid12345678')
      await vi.advanceTimersByTimeAsync(6000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the parsed page snapshot, unaffected by the debug-gated held count', async () => {
    const manager = await loggedInManager()
    const html =
      '<script>window["ytInitialData"] = {"x":1,"r":"liveChatAutoModMessageRenderer"};</script>'
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(html, { status: 200 })))

    await expect(manager.fetchLiveChatBootstrap('cont-token', 'vid12345678')).resolves.toEqual({
      x: 1,
      r: 'liveChatAutoModMessageRenderer'
    })
  })

  it('recovers from a 401 on the bootstrap GET, then returns the retried snapshot (S2-4)', async () => {
    const manager = newManager(new FakeStore())
    create
      .mockResolvedValueOnce(session(true) as never) // login
      .mockResolvedValueOnce(session(true) as never) // rebuild after the rotate
    await manager.setCookies('SAPISID=abc; SID=xyz')

    const html = '<script>window["ytInitialData"] = {"ok":true};</script>'
    let liveChatHits = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('/live_chat?')) {
        liveChatHits += 1
        // First GET is rejected by a stale rotating cookie; after the rotate the retry succeeds.
        return Promise.resolve(
          liveChatHits === 1
            ? new Response('', { status: 401 })
            : new Response(html, { status: 200 })
        )
      }
      if (url.includes('RotateCookiesPage')) {
        return Promise.resolve(new Response("init('-1', 0.0)", { status: 200 }))
      }
      return Promise.resolve(new Response('', { status: 200 }))
    })

    await expect(manager.fetchLiveChatBootstrap('cont-token', 'vid12345678')).resolves.toEqual({
      ok: true
    })
    expect(liveChatHits).toBe(2)
  })
})

describe('YouTubeAuthManager.runHeldAction', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const encodeToken = (endpoint: unknown): string =>
    Buffer.from(JSON.stringify(endpoint), 'utf8').toString('base64')

  async function loggedIn(execute: ReturnType<typeof vi.fn>): Promise<YouTubeAuthManager> {
    const manager = newManager(new FakeStore())
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')
    return manager
  }

  it('replays a moderation held token via live_chat/moderate', async () => {
    const execute = vi.fn().mockResolvedValue({ data: {} })
    const manager = await loggedIn(execute)

    await manager.runHeldAction(encodeToken({ moderateLiveChatEndpoint: { params: 'SHOW' } }))

    expect(execute).toHaveBeenCalledWith('live_chat/moderate', { params: 'SHOW', parse: false })
  })

  it('rejects a held token that is not a moderation action, executing nothing (S2-6)', async () => {
    const execute = vi.fn()
    const manager = await loggedIn(execute)

    await expect(
      manager.runHeldAction(encodeToken({ urlEndpoint: { url: 'https://evil/' } }))
    ).rejects.toThrow(/no longer available/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a malformed token', async () => {
    const execute = vi.fn()
    const manager = await loggedIn(execute)

    await expect(manager.runHeldAction('@@not-base64-json@@')).rejects.toThrow(
      /no longer available/
    )
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('YouTubeAuthManager cookie rotation', () => {
  beforeEach(() => {
    create.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rotates the session via RotateCookies only after a restore fails auth, then recovers', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        const body = url.includes('RotateCookiesPage')
          ? "init('-987654321', 0.0, 1.0, 0.0, 600.0)"
          : ''
        return Promise.resolve(new Response(body, { status: 200 }))
      })
    )

    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz' })
    const manager = newManager(store)
    create
      // First validation fails auth (stale rotating token); after rotation it succeeds.
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
      .mockResolvedValueOnce(instanceWith([accountItem({ name: 'Me', selected: true })]) as never)

    await manager.init()

    const post = calls.find((call) => call.url === 'https://accounts.youtube.com/RotateCookies')
    expect(post?.init?.method).toBe('POST')
    expect(String(post?.init?.body)).toContain('-987654321')
    expect(manager.isLoggedIn).toBe(true)
  })

  it('does not rotate when the restored session still authenticates', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        calls.push(String(input))
        return Promise.resolve(new Response('', { status: 200 }))
      })
    )

    const store = new FakeStore()
    store.set('youtube', { cookie: 'SAPISID=abc; SID=xyz' })
    const manager = newManager(store)
    create.mockResolvedValueOnce(
      instanceWith([accountItem({ name: 'Me', selected: true })]) as never
    )

    await manager.init()

    expect(calls.some((url) => url.includes('RotateCookies'))).toBe(false)
    expect(manager.isLoggedIn).toBe(true)
  })
})

describe('YouTubeAuthManager.checkSendRestriction', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function loggedInManager(execute: ReturnType<typeof vi.fn>): Promise<YouTubeAuthManager> {
    const manager = newManager(new FakeStore())
    create.mockResolvedValueOnce({
      session: { logged_in: true },
      account: { getInfo: vi.fn().mockResolvedValue([]) },
      actions: { execute }
    } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')
    return manager
  }

  function chatResponse(actionPanel: unknown): unknown {
    return { data: { continuationContents: { liveChatContinuation: { actionPanel } } } }
  }

  it('reports the reason when chat participation is restricted', async () => {
    const execute = vi.fn().mockResolvedValue(
      chatResponse({
        liveChatRestrictedParticipationRenderer: {
          message: { runs: [{ text: 'Subscribers-only mode' }] }
        }
      })
    )
    const manager = await loggedInManager(execute)

    await expect(manager.checkSendRestriction('cont-token')).resolves.toBe('Subscribers-only mode')
    expect(execute).toHaveBeenCalledWith('live_chat/get_live_chat', {
      continuation: 'cont-token',
      parse: false
    })
  })

  it('returns undefined when the user can chat (message input present)', async () => {
    const execute = vi.fn().mockResolvedValue(chatResponse({ liveChatMessageInputRenderer: {} }))
    const manager = await loggedInManager(execute)

    await expect(manager.checkSendRestriction('cont-token')).resolves.toBeUndefined()
  })

  it('returns undefined when the probe fails, so sending is never blocked', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('network'))
    const manager = await loggedInManager(execute)

    await expect(manager.checkSendRestriction('cont-token')).resolves.toBeUndefined()
  })

  it('returns undefined when not logged in', async () => {
    const manager = newManager(new FakeStore())
    await expect(manager.checkSendRestriction('cont-token')).resolves.toBeUndefined()
  })

  it('recovers from a stale-auth 401 and reports the restriction after the rebuild (S2-4)', async () => {
    const manager = newManager(new FakeStore())
    create
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: {
          execute: vi.fn().mockResolvedValue(
            chatResponse({
              liveChatRestrictedParticipationRenderer: {
                message: { runs: [{ text: 'Members-only mode' }] }
              }
            })
          )
        }
      } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    await expect(manager.checkSendRestriction('cont-token')).resolves.toBe('Members-only mode')
    expect(create).toHaveBeenCalledTimes(2)
  })
})

describe('YouTubeAuthManager.getEmojiCatalog', () => {
  beforeEach(() => {
    create.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recovers from a stale-auth 401 and returns the catalog after the rebuild (S2-4)', async () => {
    const manager = newManager(new FakeStore())
    const emojiResponse = {
      data: {
        continuationContents: {
          liveChatContinuation: {
            actionPanel: {
              liveChatMessageInputRenderer: {
                emojiPickerRenderer: {
                  categories: [
                    {
                      emojiPickerCategoryRenderer: {
                        emojiIds: ['x'],
                        categoryId: 'c',
                        emoji: [
                          {
                            emojiId: 'room/abc',
                            shortcuts: [':kappa:'],
                            image: { thumbnails: [{ url: 'http://e/kappa.png' }] }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    }
    create
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockRejectedValue(AUTH_401) }
      } as never)
      .mockResolvedValueOnce({
        session: { logged_in: true },
        account: { getInfo: vi.fn().mockResolvedValue([]) },
        actions: { execute: vi.fn().mockResolvedValue(emojiResponse) }
      } as never)
    await manager.setCookies('SAPISID=abc; SID=xyz')

    const emojis = await manager.getEmojiCatalog('cont-token')
    expect(emojis.length).toBeGreaterThan(0)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('returns [] when logged out', async () => {
    await expect(newManager(new FakeStore()).getEmojiCatalog('cont-token')).resolves.toEqual([])
  })
})

describe('YouTubeAuthManager init/auth-change races', () => {
  beforeEach(() => {
    create.mockReset()
  })

  it('a slow failing restore cannot wipe the cookies a fresh login just persisted', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SID=stale' })
    const manager = newManager(store)

    let rejectRestore!: (error: Error) => void
    create.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRestore = reject
        }) as never
    )
    const restoring = manager.init()

    // The user pastes fresh cookies while the restore crawls along on a bad network.
    create.mockResolvedValueOnce(session(true) as never)
    await manager.setCookies('SAPISID=new; SID=new')
    expect(store.get('youtube')).toEqual({ cookie: 'SAPISID=new; SID=new' })

    // The original restore now fails auth — its cleanup must be a stale no-op.
    rejectRestore(new Error('Request failed with status code 401'))
    await restoring

    expect(manager.isLoggedIn).toBe(true)
    expect(store.get('youtube')).toEqual({ cookie: 'SAPISID=new; SID=new' })
  })

  it('a restore that completes after logout cannot resurrect the session', async () => {
    const store = new FakeStore()
    store.set('youtube', { cookie: 'SID=stale' })
    const manager = newManager(store)

    let resolveRestore!: (value: unknown) => void
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve
        }) as never
    )
    const restoring = manager.init()

    manager.logout()
    resolveRestore(instanceWith([]))
    await restoring

    expect(manager.isLoggedIn).toBe(false)
    expect(store.get('youtube')).toBeUndefined()
  })
})

describe('extractYtInitialData (live_chat page bootstrap)', () => {
  it('extracts the embedded ytInitialData object', () => {
    const html = `<html><script>var ytInitialData = {"a":1,"b":{"c":"x"}};</script></html>`
    expect(extractYtInitialData(html)).toEqual({ a: 1, b: { c: 'x' } })
  })

  it('is not unbalanced by braces inside a message string', () => {
    // A chat message containing braces must not end the object scan early.
    const html = `window["ytInitialData"] = {"msg":"a } b { c","ok":true};\n</script>`
    expect(extractYtInitialData(html)).toEqual({ msg: 'a } b { c', ok: true })
  })

  it('handles an escaped quote inside a string', () => {
    const html = `ytInitialData = {"t":"say \\"hi\\" }","n":2};`
    expect(extractYtInitialData(html)).toEqual({ t: 'say "hi" }', n: 2 })
  })

  it('returns undefined when the marker is absent or the slice is not JSON', () => {
    expect(extractYtInitialData('<html>no data here</html>')).toBeUndefined()
    expect(extractYtInitialData('ytInitialData = {not valid json}')).toBeUndefined()
  })
})
