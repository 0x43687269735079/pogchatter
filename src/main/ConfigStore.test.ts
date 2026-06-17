import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ConfigStore reads/writes a real config.json under Electron's userData dir; point that at a temp
// dir (cross-platform via os.tmpdir — imported dynamically because hoisted code runs before the
// static imports are initialized) and exercise the real file I/O (only Electron's `app` is mocked).
const userData = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os')
  return `${tmpdir()}/pogchatter-cfg-${process.pid}`
})
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { ConfigStore } = await import('@main/ConfigStore')
const CONFIG = join(userData, 'config.json')

beforeEach(() => {
  mkdirSync(userData, { recursive: true })
  if (existsSync(CONFIG)) {
    rmSync(CONFIG)
  }
})
afterEach(() => {
  if (existsSync(CONFIG)) {
    rmSync(CONFIG)
  }
})

const DEFAULTS = {
  devMode: false,
  bufferSize: 500,
  highlights: [],
  monitors: [],
  moderation: { rules: [], sound: true, notify: false },
  preban: { enabled: false, dryRun: true, rules: [] },
  monitoredUsers: [],
  theme: 'ice',
  fontSize: 13,
  emoteProviders: { sevenTv: true, bttv: true, ffz: true },
  columnOrder: [],
  layout: 'scroll',
  chatLog: { enabled: false, directory: '' },
  allowPlaintextCredentials: false,
  keepAwake: true
}

describe('ConfigStore settings', () => {
  it('returns the defaults when no config exists', () => {
    expect(new ConfigStore().settings()).toEqual(DEFAULTS)
  })

  it('persists a setting and a fresh instance reads it back', () => {
    expect(new ConfigStore().setSettings({ devMode: true })).toEqual({ ...DEFAULTS, devMode: true })
    expect(new ConfigStore().settings()).toEqual({ ...DEFAULTS, devMode: true })
  })

  it('clamps the buffer size to the supported range and rounds it', () => {
    const store = new ConfigStore()
    expect(store.setSettings({ bufferSize: 999999 }).bufferSize).toBe(5000)
    expect(store.setSettings({ bufferSize: 1 }).bufferSize).toBe(100)
    expect(store.setSettings({ bufferSize: 750.6 }).bufferSize).toBe(751)
    expect(store.setSettings({ bufferSize: Number.NaN } as never).bufferSize).toBe(751)
  })

  it('ignores unknown keys and wrong types (renderer cannot inject arbitrary config)', () => {
    const store = new ConfigStore()
    expect(store.setSettings({ devMode: 'yes', secret: 'x' } as never)).toEqual(DEFAULTS)
    expect(store.setSettings({ devMode: true })).toEqual({ ...DEFAULTS, devMode: true })
  })

  it('accepts the two chat layouts and the active tab id, rejecting anything else', () => {
    const store = new ConfigStore()
    // Default is the side-by-side layout, with no remembered tab.
    expect(store.settings().layout).toBe('scroll')
    expect(store.settings().activeTabId).toBeUndefined()
    expect(store.setSettings({ layout: 'tabs' }).layout).toBe('tabs')
    expect(store.setSettings({ layout: 'scroll' }).layout).toBe('scroll')
    // An unknown value is dropped from the patch, so the prior value is kept (merge semantics).
    expect(store.setSettings({ layout: 'grid' } as never).layout).toBe('scroll')
    expect(store.setSettings({ activeTabId: 'youtube:@foo' }).activeTabId).toBe('youtube:@foo')
    // Empty / wrong-typed active tab ids are ignored, leaving the last valid one in place.
    expect(store.setSettings({ activeTabId: '' }).activeTabId).toBe('youtube:@foo')
    expect(store.setSettings({ activeTabId: 42 } as never).activeTabId).toBe('youtube:@foo')
  })

  it('keeps only valid highlight rules', () => {
    const result = new ConfigStore().setSettings({
      highlights: [
        { pattern: 'alice', isRegex: false, target: 'user', sound: true, notify: true },
        { pattern: 'bob', isRegex: false, target: 'user', notify: 'yes' }, // bad notify → dropped key
        { pattern: '', isRegex: false, target: 'user' }, // empty pattern → dropped
        { pattern: 'x', isRegex: false, target: 'nope' }, // bad target → dropped
        'garbage'
      ]
    } as never)
    expect(result.highlights).toEqual([
      { pattern: 'alice', isRegex: false, target: 'user', sound: true, notify: true },
      { pattern: 'bob', isRegex: false, target: 'user' }
    ])
  })

  it('keeps only valid monitor views and filters non-string members', () => {
    const result = new ConfigStore().setSettings({
      monitors: [
        { id: 'm1', label: 'Watch', members: ['youtube:aaa', 42, 'youtube:bbb'] },
        { id: '', label: 'no id', members: [] }, // empty id → dropped
        { id: 'm2', label: 'bad members', members: 'nope' }, // members not an array → dropped
        'garbage'
      ]
    } as never)
    expect(result.monitors).toEqual([
      { id: 'm1', label: 'Watch', members: ['youtube:aaa', 'youtube:bbb'] }
    ])
  })

  it('keeps valid moderation terms, drops empties, and defaults the alert toggles', () => {
    const result = new ConfigStore().setSettings({
      moderation: {
        rules: [
          { pattern: 'scam', isRegex: false },
          { pattern: '', isRegex: false }, // empty → dropped
          'garbage'
        ],
        notify: true
      }
    } as never)
    expect(result.moderation).toEqual({
      rules: [{ pattern: 'scam', isRegex: false }],
      sound: true, // missing → default on
      notify: true
    })
  })

  it('sanitizes chat-log settings, coercing types', () => {
    const result = new ConfigStore().setSettings({
      chatLog: { enabled: 'yes', directory: 42 }
    } as never)
    expect(result.chatLog).toEqual({ enabled: false, directory: '' })
  })

  it('falls back to defaults for a garbage settings value in the file', () => {
    writeFileSync(CONFIG, JSON.stringify({ channels: [], settings: 'nope' }))
    expect(new ConfigStore().settings()).toEqual(DEFAULTS)
  })
})

describe('ConfigStore channels', () => {
  it('round-trips a channel with an optional label', () => {
    const store = new ConfigStore()
    store.addChannel({
      platform: 'youtube',
      target: 'aaaaaaaaaaa',
      id: 'youtube:aaaaaaaaaaa',
      label: 'Live now'
    })
    expect(new ConfigStore().channels()).toEqual([
      { platform: 'youtube', target: 'aaaaaaaaaaa', id: 'youtube:aaaaaaaaaaa', label: 'Live now' }
    ])
  })

  it('drops a persisted channel whose label is the wrong type', () => {
    writeFileSync(
      CONFIG,
      JSON.stringify({
        channels: [{ platform: 'youtube', target: 'a', id: 'youtube:a', label: 5 }],
        settings: {}
      })
    )
    expect(new ConfigStore().channels()).toEqual([])
  })

  it('recomputes a stale persisted id from the target (older normalization scheme)', () => {
    const url = 'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow'
    writeFileSync(
      CONFIG,
      JSON.stringify({
        channels: [{ platform: 'youtube', target: url, id: `youtube:${url}` }],
        settings: {}
      })
    )
    expect(new ConfigStore().channels()).toEqual([
      { platform: 'youtube', target: url, id: 'youtube:UCSJ4gkVC6NrvII8umztf0Ow' }
    ])
  })

  it('collapses persisted entries whose targets normalize to one id, keeping the first', () => {
    writeFileSync(
      CONFIG,
      JSON.stringify({
        channels: [
          { platform: 'youtube', target: '@LofiGirl', id: 'youtube:@lofigirl', label: 'first' },
          { platform: 'youtube', target: 'lofigirl', id: 'youtube:@lofigirl', label: 'second' }
        ],
        settings: {}
      })
    )
    expect(new ConfigStore().channels()).toEqual([
      { platform: 'youtube', target: '@LofiGirl', id: 'youtube:@lofigirl', label: 'first' }
    ])
  })
})
