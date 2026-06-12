import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migration state in the new directory: `{}` when fully migrated, `{"failed":[...]}` when a
 * partial run still needs a retry. A dedicated file (instead of overloading config.json's
 * existence, as earlier versions did) so a session that writes config.json after a partial
 * migration can't silently cancel the retry.
 */
const MARKER_FILE = '.migrated.json'

/** Whether the marker records a fully completed migration (an unreadable one counts as done —
 * never risk re-copying legacy data over a live session's files on every launch). */
function markerSaysDone(markerPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return true
  }
  try {
    const state: unknown = JSON.parse(raw)
    if (typeof state !== 'object' || state === null) {
      return true
    }
    const failed = (state as { failed?: unknown }).failed
    return !Array.isArray(failed) || failed.length === 0
  } catch {
    return true
  }
}

function tryWriteMarker(markerPath: string, failed: string[]): void {
  try {
    writeFileSync(markerPath, JSON.stringify(failed.length > 0 ? { failed } : {}))
  } catch {
    // Tolerated like every copy failure: with no marker the next launch retries, and retries
    // skip files that already exist, so a re-run can never clobber anything.
  }
}

/**
 * One-time migration from the pre-"Pogchatter" data directory: the app's userData was named
 * after the package (youtube-chat-addon) until productName was set, so existing installs keep
 * their config, credentials, and chat logs there. Copies only this app's own files plus
 * Chromium's "Local State" — on Windows that file holds the DPAPI-wrapped safeStorage key, so
 * without it the copied auth.bin can't decrypt. (On macOS and GNOME-keyring systems the key is
 * a keychain entry named after the app, which a rename can't follow — those re-login once;
 * KWallet's entry is not app-named, so KDE logins survive.) Tolerates every failure, so a
 * partial copy can never block startup.
 *
 * `config.json` is copied first, so channels and settings survive even a partially failed run
 * (antivirus lock, disk full). A partial run records its failures in the {@link MARKER_FILE}
 * marker and retries on the next launch; retries never overwrite a file that already exists in
 * the new directory, so data the intervening session wrote (a re-login's auth.bin, appended
 * chat logs, a re-built config.json) always beats the stale legacy copy.
 *
 * Must run before the debug log, ConfigStore, and AuthStore open files in the new directory,
 * and only under the single-instance lock (the copies are not atomic).
 */
export function migrateLegacyUserData(
  userData: string,
  legacyDir: string
): Record<string, unknown> | undefined {
  if (!existsSync(join(legacyDir, 'config.json'))) {
    return undefined
  }
  const markerPath = join(userData, MARKER_FILE)
  if (existsSync(markerPath)) {
    if (markerSaysDone(markerPath)) {
      return undefined
    }
  } else if (existsSync(join(userData, 'config.json'))) {
    // Migrated by a version that used config.json's presence as the marker (or the new directory
    // is already in use): record that and never copy — a late re-copy could resurrect legacy
    // credentials the user has since logged out of.
    tryWriteMarker(markerPath, [])
    return undefined
  }
  const copied: string[] = []
  const failed: string[] = []
  const copy = (name: string, copyFile: () => boolean): void => {
    try {
      if (existsSync(join(legacyDir, name)) && copyFile()) {
        copied.push(name)
      }
    } catch {
      failed.push(name)
    }
  }
  try {
    mkdirSync(userData, { recursive: true })
  } catch {
    return { from: legacyDir, error: 'could not create the new data directory' }
  }
  for (const file of ['config.json', 'auth.bin', 'auth.json', 'Local State']) {
    copy(file, () => {
      // A file already in the new directory was copied by an earlier partial run or written
      // fresh by a session since — either way it is newer truth than the legacy copy.
      if (existsSync(join(userData, file))) {
        return false
      }
      copyFileSync(join(legacyDir, file), join(userData, file))
      return true
    })
  }
  copy('chat-logs', () => {
    // force:false fills in whatever is missing without touching log files a session has
    // appended to since the first attempt.
    cpSync(join(legacyDir, 'chat-logs'), join(userData, 'chat-logs'), {
      recursive: true,
      force: false
    })
    return true
  })
  tryWriteMarker(markerPath, failed)
  return { from: legacyDir, copied, ...(failed.length > 0 ? { failed } : {}) }
}
