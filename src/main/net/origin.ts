/** Pure URL-trust helpers for the main process (no Electron deps, so they're unit-testable). */

import { fileURLToPath } from 'node:url'

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/** True if a URL points at a loopback host (used to bound the debug proxy's TLS bypass). */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A dev renderer URL is only honored if it's an http(s) loopback origin. */
export function isLoopbackRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHost(parsed.hostname)
    )
  } catch {
    return false
  }
}

/**
 * Whether `url` is the app's own renderer document. In development, any page on the loopback
 * dev origin; in production, only the exact bundled `index.html` file. Used to lock down
 * navigation and to verify the IPC sender, so no other page can inherit the preload bridge.
 */
export function isTrustedRendererUrl(
  url: string | undefined,
  rendererUrl: string | undefined,
  appFilePath: string
): boolean {
  if (url === undefined || url === '') {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (rendererUrl !== undefined) {
    try {
      return parsed.origin === new URL(rendererUrl).origin
    } catch {
      return false
    }
  }
  if (parsed.protocol !== 'file:') {
    return false
  }
  // Compare via the OS path, not the raw URL pathname, so Windows drive/slash differences
  // (`/C:/app/index.html` vs `C:\app\index.html`) still match the bundled file path.
  try {
    return fileURLToPath(parsed) === appFilePath
  } catch {
    return false
  }
}
