import { describe, expect, it } from 'vitest'
import { isValidSendReply } from '@main/sendReply'

describe('isValidSendReply', () => {
  it('accepts an absent reply', () => {
    expect(isValidSendReply(undefined)).toBe(true)
  })

  it('accepts a minimal reply (parentId only) and a full string reply', () => {
    expect(isValidSendReply({ parentId: 'm1' })).toBe(true)
    expect(
      isValidSendReply({
        parentId: 'm1',
        parentAuthor: 'Bob',
        parentText: 'hi',
        threadId: 'root1',
        threadAuthor: 'Ann'
      })
    ).toBe(true)
  })

  it('rejects a missing, empty, or non-string parentId', () => {
    expect(isValidSendReply({})).toBe(false)
    expect(isValidSendReply({ parentId: '' })).toBe(false)
    expect(isValidSendReply({ parentId: 5 })).toBe(false)
  })

  it('rejects non-string optional fields (the renderer-crash vector)', () => {
    expect(isValidSendReply({ parentId: 'm1', parentAuthor: {} })).toBe(false)
    expect(isValidSendReply({ parentId: 'm1', parentText: {} })).toBe(false)
    expect(isValidSendReply({ parentId: 'm1', threadId: 5 })).toBe(false)
    expect(isValidSendReply({ parentId: 'm1', threadAuthor: [] })).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isValidSendReply(null)).toBe(false)
    expect(isValidSendReply('m1')).toBe(false)
    expect(isValidSendReply(42)).toBe(false)
  })
})
