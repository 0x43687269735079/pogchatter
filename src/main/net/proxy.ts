import type { Dispatcher } from 'undici'
import { isLoopbackUrl } from '@main/net/origin'

let dispatcherPromise: Promise<Dispatcher> | undefined

/** The configured proxy URL, or undefined when none is set. */
export function proxyUrl(): string | undefined {
  const url = process.env['PROXY_URL']?.trim()
  return url !== undefined && url !== '' ? url : undefined
}

/**
 * Whether the TLS-verification bypass is active. Honored only for a loopback proxy, since
 * disabling cert checks for a remote proxy would let it MITM credentialed traffic.
 */
export function proxyIgnoresCert(): boolean {
  const url = proxyUrl()
  return url !== undefined && process.env['PROXY_IGNORE_CERT'] === 'true' && isLoopbackUrl(url)
}

/**
 * Build the upstream-proxy dispatcher, once.
 *
 * undici is imported lazily, only when `PROXY_URL` is set: merely importing the bundled copy
 * registers it as the process-wide dispatcher for Node's built-in fetch (a cross-version
 * global hijack of Electron's internal undici), which a normal launch must never trigger.
 *
 * `PROXY_URL` — e.g. `http://127.0.0.1:8080` — routes every outbound HTTP call
 * through a debugging proxy (Burp, mitmproxy, Charles) so requests and raw
 * responses can be inspected. `PROXY_IGNORE_CERT=true` accepts the proxy's
 * man-in-the-middle TLS certificate (required to read HTTPS bodies); it disables
 * upstream certificate verification, so it's restricted to a loopback proxy.
 */
function proxyDispatcher(url: string): Promise<Dispatcher> {
  if (dispatcherPromise === undefined) {
    dispatcherPromise = import('undici').then(({ ProxyAgent }) =>
      proxyIgnoresCert()
        ? new ProxyAgent({ uri: url, requestTls: { rejectUnauthorized: false } })
        : new ProxyAgent(url)
    )
  }
  return dispatcherPromise
}

/**
 * Drop-in `fetch` that routes through the configured upstream proxy when
 * `PROXY_URL` is set, and behaves exactly like the global `fetch` otherwise.
 * Every outbound HTTP call in the app goes through this so a single env var
 * makes all traffic (YouTube InnerTube, emote APIs, Twitch OAuth/Helix) visible
 * to a debugging proxy. (Twitch IRC runs over a WebSocket and isn't covered.)
 */
export const proxiedFetch: typeof fetch = async (input, init) => {
  const url = proxyUrl()
  if (url === undefined) {
    return fetch(input, init)
  }
  const agent = await proxyDispatcher(url)
  // `dispatcher` is undici's RequestInit extension (it routes this request via the
  // proxy) and isn't part of the DOM RequestInit type, so assert through unknown.
  return fetch(input, { ...init, dispatcher: agent } as unknown as RequestInit)
}
