import { describe, expect, it } from 'vitest'
import { isLoopbackRendererUrl, isLoopbackUrl, isTrustedRendererUrl } from '@main/net/origin'

describe('isLoopbackUrl', () => {
  it('recognizes loopback hosts only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true)
    expect(isLoopbackUrl('http://10.0.0.5:8080')).toBe(false)
    expect(isLoopbackUrl('http://evil.example.com')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})

describe('isLoopbackRendererUrl', () => {
  it('accepts http(s) loopback origins and rejects the rest', () => {
    expect(isLoopbackRendererUrl('http://localhost:5173')).toBe(true)
    expect(isLoopbackRendererUrl('https://127.0.0.1:5173')).toBe(true)
    expect(isLoopbackRendererUrl('http://evil.example.com')).toBe(false)
    expect(isLoopbackRendererUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('isTrustedRendererUrl', () => {
  const appFile = '/app/out/renderer/index.html'

  it('in production, trusts only the exact bundled file', () => {
    expect(isTrustedRendererUrl('file:///app/out/renderer/index.html', undefined, appFile)).toBe(
      true
    )
    expect(isTrustedRendererUrl('file:///app/out/renderer/evil.html', undefined, appFile)).toBe(
      false
    )
    expect(isTrustedRendererUrl('file:///etc/passwd', undefined, appFile)).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example.com', undefined, appFile)).toBe(false)
    expect(isTrustedRendererUrl(undefined, undefined, appFile)).toBe(false)
  })

  it('in development, trusts only the loopback dev origin', () => {
    const dev = 'http://localhost:5173'
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', dev, appFile)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/', dev, appFile)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:9999/', dev, appFile)).toBe(false)
    expect(isTrustedRendererUrl('file:///app/out/renderer/index.html', dev, appFile)).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example.com', dev, appFile)).toBe(false)
  })
})
