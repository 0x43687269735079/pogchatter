import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * `--debug-log` diagnostics stream: timestamped, high-signal lines on stdout and
 * `<userData>/debug.log` (one file per run), for users to capture from a terminal and send in.
 * Everything here may leave the user's machine — channel ids, event kinds, states, counts,
 * durations, and error messages only; never cookies, tokens, or message text.
 */

// Defense in depth: a caller should never pass secrets, but if a data key smells like one,
// drop its value before it can reach the stream.
const SECRET_KEY = /cookie|token|authorization|secret|password|credential/i

let enabled = false
let logPath: string | undefined
let stream: WriteStream | undefined

/** Whether `--debug-log` was passed, so callers can skip building per-event log data. */
export function debugLogEnabled(): boolean {
  return enabled
}

/** The debug.log path, when debug logging is on and the file opened. */
export function debugLogPath(): string | undefined {
  return logPath
}

/**
 * Enable debug logging when the app was launched with `--debug-log`,
 * open the per-run log file, and emit the environment banner. Without the flag this is a no-op
 * and every later {@link debugLog} call costs one boolean check.
 */
export function initDebugLog(): void {
  if (!app.commandLine.hasSwitch('debug-log')) {
    return
  }
  enabled = true
  const userData = app.getPath('userData')
  try {
    mkdirSync(userData, { recursive: true })
  } catch {
    // The directory usually exists; if it can't be created the open below fails and
    // debug logging continues on stdout alone.
  }
  try {
    const path = join(userData, 'debug.log')
    const fileStream = createWriteStream(path, { flags: 'w' })
    // fs opens the fd asynchronously: an open/write failure surfaces as an 'error' event,
    // which without a listener would crash the process. Fall back to stdout-only.
    fileStream.on('error', (error) => {
      stream = undefined
      logPath = undefined
      debugLog('debug', 'log file unavailable — continuing on stdout only', {
        error: error.message
      })
    })
    stream = fileStream
    logPath = path
  } catch {
    // stdout still works.
  }
  debugLog('debug', 'debug logging started', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    // Where the binary ran from — a UNC/network or VM-shared path here explains Chromium
    // child-process launch failures (the window never appearing) without further questions.
    execPath: process.execPath,
    userData,
    logFile: logPath ?? 'unavailable'
  })
}

/**
 * Emit one debug line — `[ISO time] [category] message {json}` — to stdout and the log file.
 * No-op unless {@link initDebugLog} enabled logging. Values under secret-looking keys are
 * redacted; data that can't stringify is replaced, never thrown.
 */
export function debugLog(category: string, message: string, data?: Record<string, unknown>): void {
  if (!enabled) {
    return
  }
  const line = `[${new Date().toISOString()}] [${category}] ${message}${stringify(data)}\n`
  process.stdout.write(line)
  stream?.write(line)
}

/** End the debug-log stream so buffered lines flush; safe to call repeatedly. */
export function closeDebugLog(): void {
  stream?.end()
  stream = undefined
}

function stringify(data: Record<string, unknown> | undefined): string {
  if (data === undefined) {
    return ''
  }
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    clean[key] = SECRET_KEY.test(key) ? '[redacted]' : value
  }
  try {
    return ` ${JSON.stringify(clean)}`
  } catch {
    // A circular or otherwise unserializable value must not crash the logged code path.
    return ' {"debug":"data not serializable"}'
  }
}
