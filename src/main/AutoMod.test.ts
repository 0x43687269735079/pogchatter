import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BanRule, ChatAction, ChatEvent, ChatMessage, PrebanSettings } from '@shared/model'
import { AutoMod, banAction, matchBanRule } from '@main/AutoMod'

function message(
  // menuToken admits an explicit `undefined` so a test can model a message with no action menu.
  overrides: Omit<Partial<ChatMessage>, 'menuToken'> & {
    name?: string
    menuToken?: string | undefined
  } = {}
): ChatMessage {
  const name = overrides.name ?? 'baduser'
  const menuToken = 'menuToken' in overrides ? overrides.menuToken : 'tok'
  return {
    id: overrides.id ?? `m-${name}`,
    platform: overrides.platform ?? 'twitch',
    channelId: 'twitch:chan',
    timestamp: 0,
    author: {
      id: overrides.author?.id ?? `id-${name}`,
      name,
      displayName: overrides.author?.displayName ?? name,
      badges: [],
      roles: overrides.author?.roles ?? { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: 'hi' }],
    ...(menuToken !== undefined && { menuToken }),
    ...(overrides.system !== undefined && { system: overrides.system }),
    ...(overrides.self !== undefined && { self: overrides.self })
  }
}

const BAN: ChatAction = { id: 'ban', label: 'Ban user', destructive: true }

interface Harness {
  mod: AutoMod
  settings: PrebanSettings
  actions: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  emitted: ChatEvent[]
}

function harness(rules: BanRule[], overrides: Partial<PrebanSettings> = {}): Harness {
  const settings: PrebanSettings = { enabled: true, dryRun: false, rules, ...overrides }
  const actions = vi.fn().mockResolvedValue([BAN])
  const run = vi.fn().mockResolvedValue(undefined)
  const emitted: ChatEvent[] = []
  const mod = new AutoMod({
    settings: () => settings,
    getMessageActions: actions,
    runMessageAction: run,
    emit: (event) => emitted.push(event)
  })
  return { mod, settings, actions, run, emitted }
}

function noticeTexts(emitted: ChatEvent[]): string[] {
  return emitted.map((event) =>
    event.kind === 'message' && event.message.fragments[0]?.type === 'text'
      ? event.message.fragments[0].text
      : ''
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('matchBanRule', () => {
  const rule = (pattern: string, extra: Partial<BanRule> = {}): BanRule => ({
    pattern,
    isRegex: false,
    ...extra
  })

  it('matches the handle or the display name, case-insensitively', () => {
    const msg = message({ name: 'evil_alt', author: { displayName: 'Evil Alt' } as never })
    expect(matchBanRule(msg, [rule('EVIL_ALT')])).toBeDefined()
    expect(matchBanRule(msg, [rule('evil alt')])).toBeDefined()
    expect(matchBanRule(msg, [rule('someone-else')])).toBeUndefined()
  })

  it('literal rules require the exact name — a substring does not match', () => {
    const msg = message({ name: 'spongebobfan', author: { displayName: 'Hannah' } as never })
    expect(matchBanRule(msg, [rule('bob')])).toBeUndefined()
    expect(matchBanRule(msg, [rule('ann')])).toBeUndefined()
    expect(matchBanRule(msg, [rule('hannah')])).toBeDefined()
  })

  it('literal rules tolerate a leading @ on the pattern or the name', () => {
    expect(matchBanRule(message({ name: 'baduser' }), [rule('@BadUser')])).toBeDefined()
    expect(matchBanRule(message({ name: '@baduser' }), [rule('baduser')])).toBeDefined()
  })

  it('supports regex rules (matched anywhere) and never throws on an invalid one', () => {
    const msg = message({ name: 'evil_alt42' })
    expect(matchBanRule(msg, [rule('^evil_alt\\d+$', { isRegex: true })])).toBeDefined()
    expect(matchBanRule(msg, [rule('evil_', { isRegex: true })])).toBeDefined()
    expect(matchBanRule(msg, [rule('[unclosed', { isRegex: true })])).toBeUndefined()
  })

  it('respects per-rule platform scoping (omitted = both)', () => {
    const twitchMsg = message({ platform: 'twitch' })
    const youtubeMsg = message({ platform: 'youtube' })
    const ytOnly = [rule('baduser', { platforms: ['youtube'] })]
    expect(matchBanRule(twitchMsg, ytOnly)).toBeUndefined()
    expect(matchBanRule(youtubeMsg, ytOnly)).toBeDefined()
    expect(matchBanRule(twitchMsg, [rule('baduser')])).toBeDefined()
  })
})

describe('banAction', () => {
  it("selects Twitch's ban id and YouTube's REMOVE_CIRCLE", () => {
    expect(banAction([BAN])?.id).toBe('ban')
    expect(
      banAction([
        { id: 'FLAG', label: 'Report', destructive: false },
        { id: 'REMOVE_CIRCLE', label: 'Hide user on this channel', destructive: true }
      ])?.id
    ).toBe('REMOVE_CIRCLE')
  })

  it('falls back to a destructive non-timeout action labelled like a ban', () => {
    const actions: ChatAction[] = [
      { id: 'HOURGLASS', label: 'Put user in timeout', destructive: true, timeoutDurations: [60] },
      { id: 'NEW_ICON', label: 'Hide user on this channel', destructive: true }
    ]
    expect(banAction(actions)?.id).toBe('NEW_ICON')
  })

  it('returns undefined for a viewer menu (report/block only)', () => {
    expect(banAction([{ id: 'FLAG', label: 'Report', destructive: false }])).toBeUndefined()
  })
})

describe('AutoMod', () => {
  const rules: BanRule[] = [{ pattern: 'baduser', isRegex: false, note: 'from rae mods' }]

  it('bans a matching author on their first message and audits it', async () => {
    const h = harness(rules)
    await h.mod.onMessage('twitch:chan', message())
    expect(h.run).toHaveBeenCalledWith('twitch:chan', 'tok', 'ban')
    expect(noticeTexts(h.emitted).join('')).toContain('banned "baduser"')
    expect(noticeTexts(h.emitted).join('')).toContain('from rae mods')
  })

  it('acts once per author per channel, not on every message', async () => {
    const h = harness(rules)
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled, even with matching rules', async () => {
    const h = harness(rules, { enabled: false })
    await h.mod.onMessage('twitch:chan', message())
    expect(h.actions).not.toHaveBeenCalled()
    expect(h.emitted).toHaveLength(0)
  })

  it('dry run logs the verdict without running the action', async () => {
    const h = harness(rules, { dryRun: true })
    await h.mod.onMessage('twitch:chan', message())
    expect(h.run).not.toHaveBeenCalled()
    expect(noticeTexts(h.emitted).join('')).toContain('DRY RUN — would ban "baduser"')
  })

  it('never actions staff, self, system lines, or messages without a menu token', async () => {
    const h = harness(rules)
    await h.mod.onMessage(
      'twitch:chan',
      message({ author: { roles: { broadcaster: false, moderator: true } } as never })
    )
    await h.mod.onMessage('twitch:chan', message({ self: true }))
    await h.mod.onMessage('twitch:chan', message({ system: true }))
    await h.mod.onMessage('twitch:chan', message({ menuToken: undefined }))
    expect(h.actions).not.toHaveBeenCalled()
  })

  it('reports "can\'t moderate here" once per channel when the menu offers no ban', async () => {
    const h = harness(rules)
    h.actions.mockResolvedValue([{ id: 'FLAG', label: 'Report', destructive: false }])
    await h.mod.onMessage('twitch:chan', message({ name: 'baduser' }))
    await h.mod.onMessage('twitch:chan', message({ name: 'baduserette' }))
    expect(h.run).not.toHaveBeenCalled()
    const notices = noticeTexts(h.emitted)
    expect(notices.filter((text) => text.includes("can't moderate here"))).toHaveLength(1)
  })

  it('rate-caps a runaway rule: skips past the cap, notices once, retries after the window', async () => {
    const h = harness([{ pattern: 'user\\d+', isRegex: true }])
    for (let i = 0; i < 7; i += 1) {
      await h.mod.onMessage('twitch:chan', message({ name: `user${i}` }))
    }
    expect(h.run).toHaveBeenCalledTimes(5)
    const capNotices = noticeTexts(h.emitted).filter((text) => text.includes('rate cap'))
    expect(capNotices).toHaveLength(1)

    // Past the window, the skipped author's next message is actioned.
    vi.setSystemTime(Date.now() + 61_000)
    await h.mod.onMessage('twitch:chan', message({ name: 'user5', id: 'retry' }))
    expect(h.run).toHaveBeenCalledTimes(6)
  })

  it('dry-run verdicts count against the rate cap and dedupe per author', async () => {
    const h = harness([{ pattern: 'user\\d+', isRegex: true }], { dryRun: true })
    for (let i = 0; i < 7; i += 1) {
      await h.mod.onMessage('twitch:chan', message({ name: `user${i}` }))
    }
    await h.mod.onMessage('twitch:chan', message({ name: 'user0', id: 'again' }))
    expect(h.run).not.toHaveBeenCalled()
    const notices = noticeTexts(h.emitted)
    expect(notices.filter((text) => text.includes('DRY RUN'))).toHaveLength(5)
    expect(notices.filter((text) => text.includes('rate cap'))).toHaveLength(1)
  })

  it('no-permission matches consume no rate slots, so a moderated channel keeps its budget', async () => {
    const h = harness([{ pattern: 'user\\d+', isRegex: true }])
    h.actions.mockImplementation((channelId: string) =>
      Promise.resolve(channelId === 'twitch:modded' ? [BAN] : [])
    )
    for (let i = 0; i < 6; i += 1) {
      await h.mod.onMessage('twitch:spectator', message({ name: `user${i}` }))
    }
    expect(h.run).not.toHaveBeenCalled()

    for (let i = 0; i < 5; i += 1) {
      await h.mod.onMessage('twitch:modded', message({ name: `user${i}` }))
    }
    expect(h.run).toHaveBeenCalledTimes(5)
    expect(noticeTexts(h.emitted).filter((text) => text.includes('rate cap'))).toHaveLength(0)
  })

  it('re-actions an author seen during dry-run once dry-run is turned off', async () => {
    const h = harness(rules, { dryRun: true })
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    expect(h.run).not.toHaveBeenCalled()
    h.settings.dryRun = false
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    expect(h.run).toHaveBeenCalledWith('twitch:chan', 'tok', 'ban')
    expect(noticeTexts(h.emitted).join('')).toContain('banned "baduser"')
  })

  it("retries a failed ban on the author's next message", async () => {
    const h = harness(rules)
    h.run.mockRejectedValueOnce(new Error('Helix hiccup (500)'))
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    expect(noticeTexts(h.emitted).join('')).toContain('failed to ban')
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(noticeTexts(h.emitted).join('')).toContain('banned "baduser"')
  })

  it('re-actions an author first seen without moderator permissions', async () => {
    const h = harness(rules)
    h.actions.mockResolvedValueOnce([{ id: 'FLAG', label: 'Report', destructive: false }])
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    expect(h.run).not.toHaveBeenCalled()
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('bans once when the same author bursts messages before the first ban resolves', async () => {
    const h = harness(rules)
    const first = h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    const second = h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    await Promise.all([first, second])
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('surfaces an action failure as an audit line instead of throwing', async () => {
    const h = harness(rules)
    h.run.mockRejectedValue(new Error('Twitch refused the ban (403)'))
    await expect(h.mod.onMessage('twitch:chan', message())).resolves.toBeUndefined()
    expect(noticeTexts(h.emitted).join('')).toContain('failed to ban')
    expect(noticeTexts(h.emitted).join('')).toContain('403')
  })

  it('stops retrying a channel after a 401/403 ban refusal instead of burning rate slots', async () => {
    const h = harness(rules)
    h.run.mockRejectedValueOnce(
      Object.assign(new Error('Twitch refused the ban user (403) — log out and back in'), {
        statusCode: 403
      })
    )
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(noticeTexts(h.emitted).join('')).toContain('failed to ban')

    // Every further match in that channel is skipped silently: no Helix calls, no rate
    // slots, exactly one audit line for the whole failure.
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    await h.mod.onMessage('twitch:chan', message({ id: 'm3', name: 'baduser' }))
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.actions).toHaveBeenCalledTimes(1)
    expect(h.emitted).toHaveLength(1)

    // Other channels keep their budget and still ban for real.
    await h.mod.onMessage('twitch:other', message({ id: 'm4' }))
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(noticeTexts(h.emitted).join('')).toContain('banned "baduser"')
  })

  it('resumes a 401/403-paused channel after that platform re-authenticates', async () => {
    const h = harness(rules)
    h.run.mockRejectedValueOnce(
      Object.assign(new Error('Twitch refused the ban user (403)'), { statusCode: 403 })
    )
    await h.mod.onMessage('twitch:chan', message({ id: 'm1' }))
    await h.mod.onMessage('twitch:chan', message({ id: 'm2' }))
    expect(h.run).toHaveBeenCalledTimes(1)

    // A YouTube re-login is not the remedy the failure prescribed; the pause holds.
    h.mod.resetPermanentFailures('youtube')
    await h.mod.onMessage('twitch:chan', message({ id: 'm3' }))
    expect(h.run).toHaveBeenCalledTimes(1)

    // The Twitch re-login the error message prescribes lifts the pause and the ban lands.
    h.mod.resetPermanentFailures('twitch')
    await h.mod.onMessage('twitch:chan', message({ id: 'm4' }))
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(noticeTexts(h.emitted).join('')).toContain('banned "baduser"')
  })
})
