import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// AuthStore reads/writes real files under Electron's userData dir; point that at a temp dir
// (cross-platform via os.tmpdir — imported dynamically because hoisted code runs before the
// static imports are initialized) and exercise the real file I/O. Electron's `app` and
// `safeStorage` are mocked: the fake "encryption" is a reversible prefix so tests can inspect
// what landed on disk, with switches for availability and decrypt failure.
const userData = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os')
  return `${tmpdir()}/pogchatter-auth-${process.pid}`
})
const fake = vi.hoisted(() => ({
  encryptionAvailable: true,
  decryptThrows: false,
  backend: 'gnome_libsecret'
}))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => fake.encryptionAvailable,
    getSelectedStorageBackend: () => fake.backend,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (blob: Buffer) => {
      if (fake.decryptThrows) {
        throw new Error('keychain locked')
      }
      const text = blob.toString('utf8')
      if (!text.startsWith('enc:')) {
        throw new Error('not an encrypted blob')
      }
      return text.slice('enc:'.length)
    }
  }
}))

const { AuthStore } = await import('@main/auth/AuthStore')
const AUTH_BIN = join(userData, 'auth.bin')
const AUTH_JSON = join(userData, 'auth.json')

beforeEach(() => {
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  fake.encryptionAvailable = true
  fake.decryptThrows = false
  fake.backend = 'gnome_libsecret'
  // The store logs decrypt failures and memory-only fallback; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userData, { recursive: true, force: true })
})

describe('AuthStore encrypted persistence', () => {
  it('round-trips a value through the encrypted store atomically', () => {
    const store = new AuthStore()
    store.set('twitch', { refreshToken: 'r1' })

    expect(store.storageMode()).toBe('encrypted')
    expect(new AuthStore().get('twitch')).toEqual({ refreshToken: 'r1' })
    // Temp-file + rename: no lingering .tmp, and the final file is the encrypted payload.
    expect(existsSync(`${AUTH_BIN}.tmp`)).toBe(false)
    expect(readFileSync(AUTH_BIN, 'utf8')).toBe(
      `enc:${JSON.stringify({ twitch: { refreshToken: 'r1' } })}`
    )
    expect(existsSync(AUTH_JSON)).toBe(false)
  })

  it('backs up an undecryptable store instead of letting a write destroy it', () => {
    new AuthStore().set('twitch', { refreshToken: 'r1' })
    const originalBlob = readFileSync(AUTH_BIN)

    fake.decryptThrows = true
    const store = new AuthStore()
    // Unreadable is not empty: the value is gone for this session but backed up on disk.
    expect(store.get('twitch')).toBeUndefined()
    expect(readFileSync(`${AUTH_BIN}.bad`)).toEqual(originalBlob)

    // A later set() persists the new credentials without touching the backup.
    store.set('youtube', 'cookie')
    expect(readFileSync(`${AUTH_BIN}.bad`)).toEqual(originalBlob)
    fake.decryptThrows = false
    const fresh = new AuthStore()
    expect(fresh.get('youtube')).toBe('cookie')
    expect(fresh.get('twitch')).toBeUndefined()
  })
})

describe('AuthStore locked-keyring recovery', () => {
  it('merges an unreadable store into the first persist once encryption becomes available', () => {
    new AuthStore().set('twitch', { refreshToken: 'r1' })

    // Locked keyring at startup: the store exists but can't even be attempted.
    fake.encryptionAvailable = false
    const store = new AuthStore()
    expect(store.get('twitch')).toBeUndefined()
    expect(existsSync(`${AUTH_BIN}.bad`)).toBe(false)

    // The keyring unlocks mid-session; a login must not clobber the old credentials.
    fake.encryptionAvailable = true
    store.set('youtube', 'cookie')

    const fresh = new AuthStore()
    expect(fresh.get('twitch')).toEqual({ refreshToken: 'r1' })
    expect(fresh.get('youtube')).toBe('cookie')
  })

  it('backs up an unreadable store before the first persist when it still cannot decrypt', () => {
    new AuthStore().set('twitch', { refreshToken: 'r1' })
    const originalBlob = readFileSync(AUTH_BIN)

    fake.encryptionAvailable = false
    const store = new AuthStore()
    expect(store.get('twitch')).toBeUndefined()

    // Encryption comes back but the old blob is undecryptable (e.g. the keyring was reset).
    fake.encryptionAvailable = true
    fake.decryptThrows = true
    store.set('youtube', 'cookie')

    expect(readFileSync(`${AUTH_BIN}.bad`)).toEqual(originalBlob)
    fake.decryptThrows = false
    const fresh = new AuthStore()
    expect(fresh.get('youtube')).toBe('cookie')
    expect(fresh.get('twitch')).toBeUndefined()
  })

  it('never resurrects a key deleted while the store was unread (logout survives the merge)', () => {
    const seeded = new AuthStore()
    seeded.set('twitch', { refreshToken: 'r1' })
    seeded.set('youtube', { cookie: 'c1' })

    // Locked keyring at startup: the cache starts empty with the on-disk store unread.
    fake.encryptionAvailable = false
    const store = new AuthStore()
    expect(store.get('twitch')).toBeUndefined()

    // The user logs out of Twitch while the keyring is still locked…
    store.delete('twitch')
    // …then the keyring unlocks and a later write triggers the recovery merge.
    fake.encryptionAvailable = true
    store.set('youtube', { cookie: 'c2' })

    const fresh = new AuthStore()
    expect(fresh.get('twitch')).toBeUndefined()
    expect(fresh.get('youtube')).toEqual({ cookie: 'c2' })
  })

  it('drops a deleted key when the deletion itself runs after the keyring unlocked', () => {
    const seeded = new AuthStore()
    seeded.set('twitch', { refreshToken: 'r1' })
    seeded.set('youtube', { cookie: 'c1' })

    fake.encryptionAvailable = false
    const store = new AuthStore()
    expect(store.get('twitch')).toBeUndefined() // cache primed empty, store flagged unread

    // Keyring unlocks, then the user logs out: the key isn't in the cache, but the unread
    // on-disk store still holds it — the delete must purge it from the merge.
    fake.encryptionAvailable = true
    store.delete('twitch')

    const fresh = new AuthStore()
    expect(fresh.get('twitch')).toBeUndefined()
    expect(fresh.get('youtube')).toEqual({ cookie: 'c1' })
  })
})

describe('AuthStore without encryption', () => {
  it('treats the Linux basic_text backend as encryption-unavailable', () => {
    // basic_text is hardcoded-key obfuscation, not encryption: even if isEncryptionAvailable()
    // claimed otherwise, nothing may persist through it as 'encrypted'.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      fake.backend = 'basic_text'
      const store = new AuthStore()
      store.set('twitch', { refreshToken: 'r1' })

      expect(store.storageMode()).toBe('memory')
      expect(store.get('twitch')).toEqual({ refreshToken: 'r1' })
      expect(existsSync(AUTH_BIN)).toBe(false)
      expect(existsSync(AUTH_JSON)).toBe(false)
    } finally {
      if (platform !== undefined) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('keeps credentials in memory only when plaintext is not opted into', () => {
    fake.encryptionAvailable = false
    const store = new AuthStore()
    store.set('twitch', { refreshToken: 'r1' })

    expect(store.storageMode()).toBe('memory')
    expect(store.get('twitch')).toEqual({ refreshToken: 'r1' })
    expect(existsSync(AUTH_BIN)).toBe(false)
    expect(existsSync(AUTH_JSON)).toBe(false)
  })

  it('persists plaintext (0600) when the user opted in, readable by a fresh instance', () => {
    fake.encryptionAvailable = false
    const store = new AuthStore(() => true)
    store.set('twitch', { refreshToken: 'r1' })

    expect(store.storageMode()).toBe('plaintext')
    expect(JSON.parse(readFileSync(AUTH_JSON, 'utf8'))).toEqual({ twitch: { refreshToken: 'r1' } })
    if (process.platform !== 'win32') {
      expect(statSync(AUTH_JSON).mode & 0o777).toBe(0o600)
    }
    expect(new AuthStore(() => true).get('twitch')).toEqual({ refreshToken: 'r1' })
  })

  it('scrubs the plaintext store when the opt-in is revoked', () => {
    fake.encryptionAvailable = false
    writeFileSync(AUTH_JSON, JSON.stringify({ twitch: { refreshToken: 'r1' } }))

    const store = new AuthStore(() => false)
    store.refreshPersistence()

    expect(existsSync(AUTH_JSON)).toBe(false)
    // The credentials are not destroyed, just no longer persisted.
    expect(store.get('twitch')).toEqual({ refreshToken: 'r1' })
    expect(store.storageMode()).toBe('memory')
  })
})

describe('AuthStore plaintext → encrypted migration', () => {
  it('upgrades a plaintext store once encryption becomes available and scrubs the copy', () => {
    writeFileSync(AUTH_JSON, JSON.stringify({ twitch: { refreshToken: 'r1' } }))

    const store = new AuthStore()
    expect(store.get('twitch')).toEqual({ refreshToken: 'r1' })

    expect(existsSync(AUTH_JSON)).toBe(false)
    expect(readFileSync(AUTH_BIN, 'utf8')).toBe(
      `enc:${JSON.stringify({ twitch: { refreshToken: 'r1' } })}`
    )
    expect(new AuthStore().get('twitch')).toEqual({ refreshToken: 'r1' })
  })
})
