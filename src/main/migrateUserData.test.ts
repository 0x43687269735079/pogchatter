import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyUserData } from '@main/migrateUserData'

const base = join(tmpdir(), `pogchatter-migrate-${process.pid}`)
const legacy = join(base, 'youtube-chat-addon')
const userData = join(base, 'Pogchatter')
const marker = join(userData, '.migrated.json')

function seedLegacy(): void {
  mkdirSync(join(legacy, 'chat-logs'), { recursive: true })
  writeFileSync(join(legacy, 'config.json'), '{"channels":[]}')
  writeFileSync(join(legacy, 'auth.bin'), 'encrypted-blob')
  writeFileSync(join(legacy, 'Local State'), '{"os_crypt":{}}')
  writeFileSync(join(legacy, 'chat-logs', 'log.txt'), 'line')
}

/** A directory where auth.bin should be makes copyFileSync throw — a stand-in for an
 * antivirus lock or disk-full failure mid-migration. */
function obstructAuthBin(): void {
  rmSync(join(legacy, 'auth.bin'))
  mkdirSync(join(legacy, 'auth.bin'))
}

function clearObstruction(): void {
  rmSync(join(legacy, 'auth.bin'), { recursive: true })
  writeFileSync(join(legacy, 'auth.bin'), 'encrypted-blob')
}

beforeEach(() => {
  rmSync(base, { recursive: true, force: true })
  seedLegacy()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('migrateLegacyUserData', () => {
  it('copies the legacy files and records completion in the marker file', () => {
    const result = migrateLegacyUserData(userData, legacy)

    expect(readFileSync(join(userData, 'auth.bin'), 'utf8')).toBe('encrypted-blob')
    expect(readFileSync(join(userData, 'Local State'), 'utf8')).toBe('{"os_crypt":{}}')
    expect(readFileSync(join(userData, 'chat-logs', 'log.txt'), 'utf8')).toBe('line')
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"channels":[]}')
    expect(result?.['failed']).toBeUndefined()
    expect(readFileSync(marker, 'utf8')).toBe('{}')

    // The marker makes the next launch a no-op.
    expect(migrateLegacyUserData(userData, legacy)).toBeUndefined()
  })

  it('keeps config.json (copied first) on a partial failure and records the retry', () => {
    obstructAuthBin()

    const result = migrateLegacyUserData(userData, legacy)

    expect(result?.['failed']).toEqual(['auth.bin'])
    // Channels/settings survive the partial run instead of yielding a blank session.
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"channels":[]}')
    expect(readFileSync(marker, 'utf8')).toBe('{"failed":["auth.bin"]}')
  })

  it('retries after a partial failure even though the session wrote config.json', () => {
    obstructAuthBin()
    migrateLegacyUserData(userData, legacy)
    // The intervening session re-adds a channel (or persists visitorData) — the old scheme used
    // config.json's existence as the marker, which this write would have cancelled.
    writeFileSync(join(userData, 'config.json'), '{"channels":["fresh"]}')

    clearObstruction()
    const retry = migrateLegacyUserData(userData, legacy)

    expect(retry?.['failed']).toBeUndefined()
    expect(readFileSync(join(userData, 'auth.bin'), 'utf8')).toBe('encrypted-blob')
    expect(readFileSync(marker, 'utf8')).toBe('{}')
    // The session's config beats the stale legacy copy.
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"channels":["fresh"]}')
  })

  it('never clobbers files a newer session wrote when the retry runs', () => {
    obstructAuthBin()
    migrateLegacyUserData(userData, legacy)
    // Session 1: the user re-logged in (fresh auth.bin) and chat logging appended.
    writeFileSync(join(userData, 'auth.bin'), 'fresh-blob')
    writeFileSync(join(userData, 'chat-logs', 'log.txt'), 'line+appended')
    // A log file only the legacy dir has is still filled in.
    writeFileSync(join(legacy, 'chat-logs', 'older.txt'), 'old')

    clearObstruction()
    const retry = migrateLegacyUserData(userData, legacy)

    expect(retry?.['failed']).toBeUndefined()
    expect(readFileSync(join(userData, 'auth.bin'), 'utf8')).toBe('fresh-blob')
    expect(readFileSync(join(userData, 'chat-logs', 'log.txt'), 'utf8')).toBe('line+appended')
    expect(readFileSync(join(userData, 'chat-logs', 'older.txt'), 'utf8')).toBe('old')
  })

  it('marks pre-marker installs (config.json present) as done without copying', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'config.json'), '{"channels":["mine"]}')

    expect(migrateLegacyUserData(userData, legacy)).toBeUndefined()
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"channels":["mine"]}')
    expect(existsSync(join(userData, 'auth.bin'))).toBe(false)
    // The recorded marker keeps later launches from ever re-copying legacy credentials.
    expect(readFileSync(marker, 'utf8')).toBe('{}')
  })

  it('treats an unreadable marker as migrated rather than risk re-copying', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(marker, 'not json')

    expect(migrateLegacyUserData(userData, legacy)).toBeUndefined()
    expect(existsSync(join(userData, 'auth.bin'))).toBe(false)
  })

  it('does nothing when there is no legacy directory', () => {
    rmSync(legacy, { recursive: true, force: true })
    expect(migrateLegacyUserData(userData, legacy)).toBeUndefined()
    expect(existsSync(userData)).toBe(false)
  })
})
