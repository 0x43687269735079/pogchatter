import { describe, expect, it } from 'vitest'
import { autocompleteAction } from '@renderer/useEmojiInput'

describe('autocompleteAction', () => {
  it('maps the list keys', () => {
    expect(autocompleteAction('ArrowDown', false)).toBe('next')
    expect(autocompleteAction('ArrowUp', false)).toBe('previous')
    expect(autocompleteAction('Enter', false)).toBe('choose')
    expect(autocompleteAction('Tab', false)).toBe('choose')
    expect(autocompleteAction('Escape', false)).toBe('close')
  })

  it('leaves every key to the input method mid-composition', () => {
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(autocompleteAction(key, true)).toBeUndefined()
    }
  })

  it('leaves ordinary typing alone', () => {
    expect(autocompleteAction('a', false)).toBeUndefined()
    expect(autocompleteAction(' ', false)).toBeUndefined()
  })
})
