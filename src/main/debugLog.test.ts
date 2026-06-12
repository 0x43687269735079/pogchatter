import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// debugLog.ts holds module-level state (enabled flag, stream), so each test re-imports a fresh
// copy via vi.resetModules(). Electron's app and node:fs are mocked: the fake write stream
// captures lines and the --debug-log switch is toggled per test.
const fake = vi.hoisted(() => ({
  debugFlag: false,
  openThrows: false,
  fileLines: [] as string[],
  fileEnds: 0
}))

vi.mock('electron', () => ({
  app: {
    commandLine: { hasSwitch: (name: string) => name === 'debug-log' && fake.debugFlag },
    getPath: () => '/fake/user-data',
    getVersion: () => '1.2.3',
    isPackaged: true
  }
}))

vi.mock('node:fs', () => ({
  mkdirSync: () => {},
  createWriteStream: () => {
    if (fake.openThrows) {
      throw new Error('EACCES: permission denied')
    }
    return {
      write: (chunk: string): boolean => {
        fake.fileLines.push(chunk)
        return true
      },
      end: (): void => {
        fake.fileEnds += 1
      },
      on: () => {}
    }
  }
}))

let stdoutLines: string[]

async function loadDebugLog(): Promise<typeof import('@main/debugLog')> {
  return await import('@main/debugLog')
}

beforeEach(() => {
  vi.resetModules()
  fake.debugFlag = false
  fake.openThrows = false
  fake.fileLines = []
  fake.fileEnds = 0
  stdoutLines = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutLines.push(String(chunk))
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('debugLog when --debug-log is absent', () => {
  it('is a no-op: nothing enabled, nothing written', async () => {
    const { initDebugLog, debugLog, debugLogEnabled, debugLogPath } = await loadDebugLog()
    initDebugLog()
    debugLog('status', 'yt:abc', { state: 'live' })

    expect(debugLogEnabled()).toBe(false)
    expect(debugLogPath()).toBeUndefined()
    expect(stdoutLines).toEqual([])
    expect(fake.fileLines).toEqual([])
  })
})

describe('debugLog when --debug-log is set', () => {
  beforeEach(() => {
    fake.debugFlag = true
  })

  it('writes the banner, then formatted lines, to both stdout and the log file', async () => {
    const { initDebugLog, debugLog, debugLogEnabled, debugLogPath } = await loadDebugLog()
    initDebugLog()

    expect(debugLogEnabled()).toBe(true)
    expect(debugLogPath()).toBe('/fake/user-data/debug.log')
    expect(stdoutLines[0]).toContain('[debug] debug logging started')
    expect(stdoutLines[0]).toContain('"version":"1.2.3"')
    expect(stdoutLines[0]).toContain(`"execPath":${JSON.stringify(process.execPath)}`)
    expect(stdoutLines[0]).toContain('"userData":"/fake/user-data"')

    debugLog('status', 'yt:abc', { state: 'live', viewers: 42 })
    debugLog('app', 'quitting')
    const line = stdoutLines[1]
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[status\] yt:abc \{"state":"live","viewers":42\}\n$/
    )
    // Data-less lines carry no trailing JSON.
    expect(stdoutLines[2]).toMatch(/\[app\] quitting\n$/)
    expect(fake.fileLines).toEqual(stdoutLines)
  })

  it('redacts values under secret-looking keys', async () => {
    const { initDebugLog, debugLog } = await loadDebugLog()
    initDebugLog()
    debugLog('auth', 'login', {
      accessToken: 'oauth:hunter2',
      Cookie: 'SID=abc',
      channelId: 'tw:somestreamer'
    })

    const line = stdoutLines.at(-1)
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('SID=abc')
    expect(line).toContain('"accessToken":"[redacted]"')
    expect(line).toContain('"Cookie":"[redacted]"')
    expect(line).toContain('"channelId":"tw:somestreamer"')
  })

  it('survives data that JSON.stringify rejects', async () => {
    const { initDebugLog, debugLog } = await loadDebugLog()
    initDebugLog()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    expect(() => {
      debugLog('fatal', 'uncaughtException', circular)
    }).not.toThrow()
    expect(stdoutLines.at(-1)).toContain(
      '[fatal] uncaughtException {"debug":"data not serializable"}'
    )
  })

  it('keeps logging to stdout when the log file cannot be opened', async () => {
    fake.openThrows = true
    const { initDebugLog, debugLog, debugLogEnabled, debugLogPath } = await loadDebugLog()
    initDebugLog()
    debugLog('app', 'ready')

    expect(debugLogEnabled()).toBe(true)
    expect(debugLogPath()).toBeUndefined()
    expect(stdoutLines.at(-1)).toContain('[app] ready')
    expect(fake.fileLines).toEqual([])
  })

  it('ends the stream once, even when closed repeatedly', async () => {
    const { initDebugLog, closeDebugLog } = await loadDebugLog()
    initDebugLog()
    closeDebugLog()
    closeDebugLog()

    expect(fake.fileEnds).toBe(1)
  })
})
