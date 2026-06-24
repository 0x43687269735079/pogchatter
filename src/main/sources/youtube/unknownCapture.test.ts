import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the filesystem + electron boundary so the test sees what the capture would write, without I/O.
const fs = vi.hoisted(() => ({
  mkdirs: [] as string[],
  writes: [] as Array<{ path: string; data: string }>,
  writeThrows: false
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string): string => `/fake/${name}` }
}))

vi.mock('node:fs', () => ({
  mkdirSync: (dir: string): void => {
    fs.mkdirs.push(dir)
  },
  writeFileSync: (path: string, data: string): void => {
    if (fs.writeThrows) {
      throw new Error('ENOSPC: no space left on device')
    }
    fs.writes.push({ path, data })
  }
}))

const { captureUnknownAction } = await import('@main/sources/youtube/unknownCapture')

beforeEach(() => {
  fs.mkdirs.length = 0
  fs.writes.length = 0
  fs.writeThrows = false
  delete process.env['POGCHATTER_YT_CAPTURE_UNKNOWN']
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['POGCHATTER_YT_CAPTURE_UNKNOWN']
})

describe('captureUnknownAction', () => {
  const action = { addChatItemAction: { item: { liveChatModerationMessageRenderer: { id: 'x' } } } }

  it('writes nothing when the opt-in env flag is unset', () => {
    captureUnknownAction('youtube:x', 'liveChatModerationMessageRenderer', action)

    expect(fs.writes).toHaveLength(0)
    expect(fs.mkdirs).toHaveLength(0)
  })

  it('writes the full raw action as pretty JSON under a per-key file when the flag is on', () => {
    process.env['POGCHATTER_YT_CAPTURE_UNKNOWN'] = '1'

    captureUnknownAction('youtube:x', 'liveChatModerationMessageRenderer', action)

    expect(fs.mkdirs).toEqual(['/fake/userData/yt-unknown-captures'])
    expect(fs.writes).toHaveLength(1)
    const write = fs.writes[0]
    expect(write?.path).toMatch(
      /\/fake\/userData\/yt-unknown-captures\/liveChatModerationMessageRenderer-youtube_x-\d+\.json$/
    )
    // The whole action round-trips, pretty-printed (so the real shape is readable in the file).
    expect(JSON.parse(write?.data ?? '{}')).toEqual(action)
    expect(write?.data).toContain('\n  ')
  })

  it('sanitizes path-unsafe characters in the key and source id', () => {
    process.env['POGCHATTER_YT_CAPTURE_UNKNOWN'] = '1'

    captureUnknownAction('youtube:../etc', 'weird/key', action)

    expect(fs.writes[0]?.path).toMatch(/\/yt-unknown-captures\/weird_key-youtube_.._etc-\d+\.json$/)
  })

  it('swallows a write failure instead of throwing into the chat path', () => {
    process.env['POGCHATTER_YT_CAPTURE_UNKNOWN'] = '1'
    fs.writeThrows = true

    expect(() => {
      captureUnknownAction('youtube:x', 'liveChatModerationMessageRenderer', action)
    }).not.toThrow()
  })
})
