import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { CredentialStorageMode } from '@shared/model'
import { debugLog } from '@main/debugLog'

/**
 * Whether `safeStorage` offers real OS-keyring encryption. On Linux, an unrecognized desktop
 * (sway/i3, …) selects the `basic_text` backend — hardcoded-key obfuscation, not encryption — so
 * it must count as unavailable. Electron's `isEncryptionAvailable()` already returns false for
 * `basic_text`, but only as long as nobody calls `safeStorage.setUsePlainTextEncryption(true)`;
 * never introduce that call — it would silently persist obfuscated plaintext as 'encrypted'.
 * `getSelectedStorageBackend()` exists on Linux only, and returns 'unknown' (not 'basic_text')
 * before the app is ready.
 */
function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    return false
  }
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

/**
 * Encrypted-at-rest key/value store for credentials, backed by the OS keychain
 * via Electron `safeStorage`.
 *
 * When encryption is unavailable (typically Linux without a Secret Service):
 * memory-only by default — credentials survive the session but not a restart —
 * or, when the user has explicitly opted in (`allowPlaintext`), a plaintext
 * `auth.json` (0600) so they persist anyway. The plaintext copy is migrated to
 * the encrypted store and scrubbed as soon as encryption becomes available, and
 * scrubbed immediately if the opt-in is revoked. Never silent plaintext.
 *
 * All writes go to a temp file then rename, so a crash mid-write can't truncate
 * the store. An undecryptable store is backed up (`auth.bin.bad`) instead of
 * being treated as empty, so a transient keychain failure followed by a write
 * can't permanently destroy recoverable credentials.
 */
export class AuthStore {
  readonly #path: string
  readonly #plainPath: string
  readonly #allowPlaintext: () => boolean
  #cache: Record<string, unknown> | undefined
  /** An auth.bin existed on disk but has not been decrypted this session (e.g. locked keyring). */
  #unreadStore = false
  /**
   * Keys deleted this session, excluded from the unread-store recovery merge: a logout must not
   * be undone by merging the pre-session store (which still holds the key) back in later.
   */
  readonly #deletedKeys = new Set<string>()

  constructor(allowPlaintext: () => boolean = () => false) {
    this.#path = join(app.getPath('userData'), 'auth.bin')
    this.#plainPath = join(app.getPath('userData'), 'auth.json')
    this.#allowPlaintext = allowPlaintext
  }

  /** How credentials are currently held: OS-encrypted, plaintext on disk (opt-in), or memory-only. */
  storageMode(): CredentialStorageMode {
    if (encryptionAvailable()) {
      return 'encrypted'
    }
    return this.#allowPlaintext() ? 'plaintext' : 'memory'
  }

  get<T>(key: string): T | undefined {
    return this.#read()[key] as T | undefined
  }

  set(key: string, value: unknown): void {
    const data = this.#read()
    data[key] = value
    this.#deletedKeys.delete(key)
    this.#persist(data)
  }

  delete(key: string): void {
    const data = this.#read()
    this.#deletedKeys.add(key)
    if (key in data) {
      delete data[key]
      this.#persist(data)
    } else if (this.#unreadStore) {
      // The cache never saw this key, but the unread on-disk store may still hold it: persist
      // now so the recovery merge runs (and drops it) instead of resurrecting it later.
      this.#persist(data)
    }
  }

  /** Re-persist under the current policy — call when the plaintext opt-in setting changes. */
  refreshPersistence(): void {
    this.#persist(this.#read())
  }

  #read(): Record<string, unknown> {
    if (this.#cache !== undefined) {
      return this.#cache
    }
    const encrypted = this.#readEncrypted()
    if (encrypted !== undefined) {
      this.#cache = encrypted
      return this.#cache
    }
    const plain = this.#readPlaintext()
    if (plain !== undefined) {
      this.#cache = plain
      if (encryptionAvailable()) {
        // A keyring appeared since the plaintext opt-in: upgrade to the encrypted
        // store (persist also scrubs the plaintext copy).
        debugLog('auth', 'migrating plaintext credentials to the encrypted store')
        this.#persist(plain)
      }
      return this.#cache
    }
    this.#cache = {}
    return this.#cache
  }

  #readEncrypted(): Record<string, unknown> | undefined {
    if (!existsSync(this.#path)) {
      return undefined
    }
    if (!encryptionAvailable()) {
      // The store exists but can't even be attempted (e.g. locked keyring at startup). Flag it
      // so this session's first encrypted persist recovers it instead of overwriting it.
      this.#unreadStore = true
      return undefined
    }
    const data = this.#decryptStore()
    if (data === undefined) {
      this.#unreadStore = true // backed up as .bad, and a persist-time retry may still recover it
    }
    return data
  }

  #decryptStore(): Record<string, unknown> | undefined {
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(this.#path))) as Record<
        string,
        unknown
      >
    } catch (error) {
      // A transient keychain/DPAPI failure must not let a later set() persist an empty
      // store over recoverable credentials — keep the undecryptable blob aside.
      console.error('Could not read the auth store — keeping a backup as auth.bin.bad:', error)
      debugLog('auth', 'auth store undecryptable — backed up as auth.bin.bad', {
        error: error instanceof Error ? error.message : String(error)
      })
      try {
        copyFileSync(this.#path, `${this.#path}.bad`)
      } catch {
        // Best-effort backup; the original blob still exists at #path.
      }
      return undefined
    }
  }

  #readPlaintext(): Record<string, unknown> | undefined {
    // Read an existing plaintext store even if the opt-in was since revoked — losing the
    // credentials helps nobody; the next persist applies the current policy (and scrubs).
    if (!existsSync(this.#plainPath)) {
      return undefined
    }
    try {
      return JSON.parse(readFileSync(this.#plainPath, 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  #persist(data: Record<string, unknown>): void {
    if (encryptionAvailable()) {
      if (this.#unreadStore) {
        // The on-disk store predates this session and was never decrypted (locked keyring at
        // startup); availability has since flipped, so retry before the write clobbers it:
        // merge what it held under this session's values, or — when it still won't decrypt —
        // rely on the auth.bin.bad backup #decryptStore just took. Keys deleted this session
        // (logouts) are dropped from the merge, never resurrected.
        this.#unreadStore = false
        const recovered: Record<string, unknown> = { ...this.#decryptStore() }
        for (const key of this.#deletedKeys) {
          delete recovered[key]
        }
        data = { ...recovered, ...data }
      }
      this.#cache = data
      this.#write(this.#path, safeStorage.encryptString(JSON.stringify(data)))
      this.#scrubPlaintext() // a plaintext copy must not outlive the upgrade to encryption
      return
    }
    this.#cache = data
    if (this.#allowPlaintext()) {
      debugLog('auth', 'persisting credentials as plaintext', {
        mode: 'plaintext',
        why: 'no OS keyring; user opted in'
      })
      this.#write(this.#plainPath, JSON.stringify(data), 0o600)
      return
    }
    this.#scrubPlaintext() // opt-in revoked: remove any lingering plaintext copy
    console.warn('safeStorage unavailable — credentials kept in memory only this session')
    debugLog('auth', 'keeping credentials in memory only', {
      mode: 'memory',
      why: 'no OS keyring; plaintext opt-in is off'
    })
  }

  /** Write via temp-file + rename so a crash mid-write can't truncate the store. */
  #write(path: string, data: string | Buffer, mode?: number): void {
    try {
      writeFileSync(`${path}.tmp`, data, mode === undefined ? {} : { mode })
      renameSync(`${path}.tmp`, path)
    } catch (error) {
      console.error('Failed to persist auth store:', error)
    }
  }

  #scrubPlaintext(): void {
    try {
      unlinkSync(this.#plainPath)
    } catch {
      // Usually ENOENT — there was no plaintext copy to scrub.
    }
  }
}
