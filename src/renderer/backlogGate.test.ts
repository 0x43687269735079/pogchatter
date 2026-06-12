import { describe, expect, it } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/model'
import { BacklogGate } from '@renderer/backlogGate'

function batch(id: string): ChatEvent[] {
  const message: ChatMessage = {
    id,
    platform: 'youtube',
    channelId: 'c',
    timestamp: 0,
    author: {
      id: 'u',
      name: '@alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: id }]
  }
  return [{ kind: 'message', channelId: 'c', message }]
}

function collector(): { applied: ChatEvent[][]; apply: (events: ChatEvent[]) => void } {
  const applied: ChatEvent[][] = []
  return { applied, apply: (events) => applied.push(events) }
}

describe('BacklogGate', () => {
  it('holds live batches until release, then applies them in order and passes through', () => {
    const gate = new BacklogGate()
    const { applied, apply } = collector()

    gate.deliver(batch('a'), apply)
    gate.deliver(batch('b'), apply)
    expect(applied).toEqual([])

    gate.release(apply)
    expect(applied).toEqual([batch('a'), batch('b')])

    gate.deliver(batch('c'), apply)
    expect(applied).toEqual([batch('a'), batch('b'), batch('c')])
  })

  it('rearm() resumes holding for the next subscriber', () => {
    const gate = new BacklogGate()
    const { applied, apply } = collector()
    gate.release(apply)
    gate.deliver(batch('a'), apply) // passes through while released

    gate.rearm()
    gate.deliver(batch('b'), apply)
    expect(applied).toEqual([batch('a')])

    gate.release(apply)
    expect(applied).toEqual([batch('a'), batch('b')])
  })

  it('a StrictMode remount inherits batches the first mount drained from the preload queue', () => {
    const gate = new BacklogGate()

    // Mount #1 subscribes and synchronously receives the preload queue's pre-mount batches…
    const mount1 = collector()
    gate.deliver(batch('queued-1'), mount1.apply)
    gate.deliver(batch('queued-2'), mount1.apply)

    // …then StrictMode cleans it up before its backlog fetch settles (release never runs;
    // the cleanup re-arms the gate, a no-op while still holding).
    gate.rearm()

    // Mount #2's backlog fold releases — the batches mount #1 swallowed must arrive here.
    const mount2 = collector()
    gate.release(mount2.apply)

    expect(mount1.applied).toEqual([])
    expect(mount2.applied).toEqual([batch('queued-1'), batch('queued-2')])
  })
})
