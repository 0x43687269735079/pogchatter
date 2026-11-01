import { describe, expect, it } from 'vitest'
import { type FocusContext, type KeyInput, routesToComposer } from '@renderer/typeToFocus'

const key = (value: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods
})
const idle: FocusContext = { editable: false, inOverlay: false, activatable: false }

describe('routesToComposer', () => {
  it('routes printable characters typed with nothing focused', () => {
    for (const value of ['a', 'Z', '1', '?', '@', ':', ' ', 'é', '€', '😀']) {
      expect(routesToComposer(key(value), idle)).toBe(true)
    }
  })

  it('routes characters typed with Option/AltGr', () => {
    expect(routesToComposer(key('€', { altKey: true }), idle)).toBe(true)
  })

  it('routes AltGr characters, which Chromium on Windows reports as Ctrl+Alt', () => {
    expect(routesToComposer(key('@', { ctrlKey: true, altKey: true }), idle)).toBe(true)
    expect(routesToComposer(key('€', { ctrlKey: true, altKey: true }), idle)).toBe(true)
    expect(routesToComposer(key('ArrowLeft', { ctrlKey: true, altKey: true }), idle)).toBe(false)
    expect(routesToComposer(key('@', { ctrlKey: true, altKey: true, metaKey: true }), idle)).toBe(
      false
    )
  })

  it('routes paste so a clipboard lands in the composer', () => {
    expect(routesToComposer(key('v', { metaKey: true }), idle)).toBe(true)
    expect(routesToComposer(key('V', { ctrlKey: true }), idle)).toBe(true)
  })

  it('leaves shortcuts and named keys alone', () => {
    expect(routesToComposer(key('f', { metaKey: true }), idle)).toBe(false)
    expect(routesToComposer(key('c', { ctrlKey: true }), idle)).toBe(false)
    expect(routesToComposer(key('v', { metaKey: true, altKey: true }), idle)).toBe(false)
    for (const value of ['ArrowLeft', 'Enter', 'Tab', 'Escape', 'F5', 'Process', 'Dead', '']) {
      expect(routesToComposer(key(value), idle)).toBe(false)
    }
  })

  it('never steals a key from a field, menu or dialog', () => {
    expect(routesToComposer(key('a'), { ...idle, editable: true })).toBe(false)
    expect(routesToComposer(key('a'), { ...idle, inOverlay: true })).toBe(false)
    expect(routesToComposer(key('v', { metaKey: true }), { ...idle, inOverlay: true })).toBe(false)
  })

  it('lets Space activate a focused button but still routes letters from it', () => {
    const onButton = { ...idle, activatable: true }
    expect(routesToComposer(key(' '), onButton)).toBe(false)
    expect(routesToComposer(key('a'), onButton)).toBe(true)
  })
})
