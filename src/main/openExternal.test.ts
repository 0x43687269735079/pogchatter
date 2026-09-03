import { describe, expect, it } from 'vitest'
import { isOpenableUrl } from '@main/openExternal'

describe('isOpenableUrl', () => {
  it('accepts an https URL, query string and all', () => {
    expect(isOpenableUrl('https://media4.giphy.com/x.gif?a=1&b=2')).toBe(true)
  })

  it('rejects http', () => {
    expect(isOpenableUrl('http://x')).toBe(false)
  })

  it('rejects javascript:', () => {
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects file:', () => {
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects a malformed URL', () => {
    expect(isOpenableUrl('not a url')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isOpenableUrl('')).toBe(false)
  })
})
