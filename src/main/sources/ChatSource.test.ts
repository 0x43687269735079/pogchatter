import { describe, expect, it } from 'vitest'
import type { Platform, SourceStatus } from '@shared/model'
import { BaseChatSource } from '@main/sources/ChatSource'

class TestSource extends BaseChatSource {
  readonly id = 'twitch:test'
  readonly platform: Platform = 'twitch'

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}

  /** Test hook exposing the protected status setter. */
  set(status: SourceStatus): void {
    this.setStatus(status)
  }
}

function collect(source: TestSource): SourceStatus[] {
  const statuses: SourceStatus[] = []
  source.on('status', (status) => statuses.push(status))
  return statuses
}

describe('BaseChatSource.setStatus', () => {
  it('emits changes but suppresses a deep-equal re-set (e.g. a re-derived poll status)', () => {
    const source = new TestSource()
    const statuses = collect(source)

    source.set({ state: 'connecting' })
    source.set({ state: 'waiting' })
    source.set({ state: 'waiting' }) // the 30s status poll re-derives the same state
    source.set({ state: 'waiting', scheduledStart: 123 })
    source.set({ state: 'waiting', scheduledStart: 123 })
    source.set({ state: 'live' })

    expect(statuses).toEqual([
      { state: 'connecting' },
      { state: 'waiting' },
      { state: 'waiting', scheduledStart: 123 },
      { state: 'live' }
    ])
  })

  it('suppresses re-setting the initial offline state (a disconnect before any connect)', () => {
    const source = new TestSource()
    const statuses = collect(source)
    source.set({ state: 'offline' })
    expect(statuses).toEqual([])
    expect(source.status()).toEqual({ state: 'offline' })
  })

  it('distinguishes statuses by their fields, not just the state', () => {
    const source = new TestSource()
    const statuses = collect(source)

    source.set({ state: 'error', message: 'one' })
    source.set({ state: 'error', message: 'one' })
    source.set({ state: 'error', message: 'two' })
    source.set({ state: 'live', viewers: 5 })
    source.set({ state: 'live', viewers: 6 })
    source.set({ state: 'live', viewers: 6, degraded: true })

    expect(statuses).toEqual([
      { state: 'error', message: 'one' },
      { state: 'error', message: 'two' },
      { state: 'live', viewers: 5 },
      { state: 'live', viewers: 6 },
      { state: 'live', viewers: 6, degraded: true }
    ])
  })

  it('re-emits a state revisited via an intermediate one (reconnects pass through connecting)', () => {
    const source = new TestSource()
    const statuses = collect(source)

    source.set({ state: 'live' })
    source.set({ state: 'connecting' })
    source.set({ state: 'live' })

    expect(statuses).toEqual([{ state: 'live' }, { state: 'connecting' }, { state: 'live' }])
  })
})
