import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Env opt-in: dump the raw action behind an unrecognized live-chat key to a file for inspection. */
const CAPTURE_ENV = 'POGCHATTER_YT_CAPTURE_UNKNOWN'

/** Keys already captured this process run. The reader's per-instance dedup resets on each reconnect,
 *  so this bounds a debugging session to one file per distinct key rather than one per reconnect. */
const captured = new Set<string>()

/**
 * When `POGCHATTER_YT_CAPTURE_UNKNOWN=1`, write the entire raw action carrying a renderer/action key
 * the parser doesn't recognize to `<userData>/yt-unknown-captures/<key>-<source>-<time>.json` (pretty
 * JSON, full content included), so the real InnerTube shape can be read off and the parser taught it.
 * The reader calls this once per distinct new key (it owns the dedup), so each drifted shape yields a
 * single file rather than a flood.
 *
 * Off by default — then it runs not at all and writes nothing. Deliberately separate from
 * {@link debugLog}, which promises to never emit message text: a captured renderer carries the
 * notice's wording (and thus usernames), so this is an explicit, clearly-named opt-in, not the
 * redacted diagnostic log. Best-effort: a write failure is logged and swallowed, never propagated
 * into the live-chat path.
 */
export function captureUnknownAction(sourceId: string, key: string, action: unknown): void {
  // Only when explicitly opted in, and never in a packaged build (a captured file holds usernames/
  // text — matches the dev-knob scrub in index.ts). The env check is first so the common (flag-off)
  // path never touches electron's `app`.
  if (process.env[CAPTURE_ENV] !== '1' || app.isPackaged) {
    return
  }
  if (captured.has(key)) {
    return
  }
  captured.add(key)
  try {
    const dir = join(app.getPath('userData'), 'yt-unknown-captures')
    mkdirSync(dir, { recursive: true })
    const slug = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_')
    const file = join(dir, `${slug(key)}-${slug(sourceId)}-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify(action, null, 2))
    console.warn(`[youtube] captured unknown live-chat shape "${key}" to ${file}`)
  } catch (error) {
    // A dev capture must never disrupt live chat — log the failure and carry on.
    console.warn(`[youtube] unknown-shape capture failed for "${key}":`, error)
  }
}
