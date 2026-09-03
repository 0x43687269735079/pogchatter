/**
 * Whether `url` is safe to hand to the OS's default-browser opener.
 *
 * Only `https:` is allowed: `http:` is unencrypted, `javascript:`/`file:`/other schemes can reach
 * local resources or execute script, and a malformed or empty string isn't a URL at all. Renderer
 * content (a chat link, a donation message) is untrusted, so this is the one gate before
 * `shell.openExternal` ever sees it.
 *
 * @param url - The candidate URL, as received from the renderer.
 * @returns True only for a parseable URL whose protocol is exactly `https:`.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
