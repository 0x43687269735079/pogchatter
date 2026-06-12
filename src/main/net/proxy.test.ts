import { afterEach, describe, expect, it, vi } from 'vitest'

// Track ProxyAgent construction: building one is what registers the bundled undici's global
// dispatcher machinery, so a normal (proxyless) run must never reach it.
const proxyAgent = vi.hoisted(() => ({ count: 0, args: [] as unknown[] }))
vi.mock('undici', () => ({
  ProxyAgent: class {
    constructor(arg: unknown) {
      proxyAgent.count += 1
      proxyAgent.args.push(arg)
    }
  }
}))

/** Fresh module per test: the dispatcher is memoized at module scope. */
async function loadProxy(): Promise<typeof import('@main/net/proxy')> {
  vi.resetModules()
  return await import('@main/net/proxy')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  proxyAgent.count = 0
  proxyAgent.args.length = 0
})

describe('proxiedFetch', () => {
  it('passes straight through to global fetch — and never touches undici — without PROXY_URL', async () => {
    vi.stubEnv('PROXY_URL', '')
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { proxiedFetch } = await loadProxy()

    const response = await proxiedFetch('https://example.com/', { method: 'GET' })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/', { method: 'GET' })
    expect(proxyAgent.count).toBe(0)
  })

  it('builds the ProxyAgent lazily and once, passing it as the request dispatcher', async () => {
    vi.stubEnv('PROXY_URL', 'http://127.0.0.1:8080')
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { proxiedFetch } = await loadProxy()

    expect(proxyAgent.count).toBe(0) // importing the module constructs nothing

    await proxiedFetch('https://example.com/')
    await proxiedFetch('https://example.com/2')

    expect(proxyAgent.count).toBe(1)
    expect(proxyAgent.args[0]).toBe('http://127.0.0.1:8080')
    const init = fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined
    expect(init?.dispatcher).toBeDefined()
  })

  it('disables upstream TLS verification only for a loopback proxy with PROXY_IGNORE_CERT', async () => {
    vi.stubEnv('PROXY_URL', 'http://127.0.0.1:8080')
    vi.stubEnv('PROXY_IGNORE_CERT', 'true')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')))
    const { proxiedFetch, proxyIgnoresCert } = await loadProxy()

    expect(proxyIgnoresCert()).toBe(true)
    await proxiedFetch('https://example.com/')

    expect(proxyAgent.args[0]).toEqual({
      uri: 'http://127.0.0.1:8080',
      requestTls: { rejectUnauthorized: false }
    })
  })

  it('refuses the TLS bypass for a non-loopback proxy', async () => {
    vi.stubEnv('PROXY_URL', 'http://proxy.example.com:8080')
    vi.stubEnv('PROXY_IGNORE_CERT', 'true')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')))
    const { proxiedFetch, proxyIgnoresCert } = await loadProxy()

    expect(proxyIgnoresCert()).toBe(false)
    await proxiedFetch('https://example.com/')

    expect(proxyAgent.args[0]).toBe('http://proxy.example.com:8080')
  })
})
