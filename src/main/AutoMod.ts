import type {
  BanRule,
  ChatAction,
  ChatEvent,
  ChatMessage,
  Platform,
  PrebanSettings
} from '@shared/model'
import { matchesExactName, matchesPattern } from '@shared/patternMatch'

/**
 * Auto-actions (real or dry-run) allowed per rolling window. The cap exists so a bad rule (e.g. a
 * regex that matches everyone) can't mass-ban on a real account: when it trips, matches are skipped
 * (and retried after the window) instead of actioned.
 */
const RATE_CAP = 5
const RATE_WINDOW_MS = 60_000

export interface AutoModDeps {
  /** The current pre-ban settings (read per message — edits apply immediately). */
  settings(): PrebanSettings
  /** The right-click actions available to the signed-in account for a message (role-gated). */
  getMessageActions(channelId: string, menuToken: string): Promise<ChatAction[]>
  /** Run one of those actions. Throws a user-facing Error on failure. */
  runMessageAction(channelId: string, menuToken: string, actionId: string): Promise<void>
  /** Sink for the audit trail: system notices flow to the column and the chat log like any event. */
  emit(event: ChatEvent): void
}

/**
 * The first rule the author matches, against the handle or the display name, with per-rule
 * platform scoping. Literal rules must equal a name exactly (case-insensitive, leading `@`
 * tolerated) — only regex rules can match partially, because a substring literal like "ann"
 * would ban "Hannah".
 */
export function matchBanRule(message: ChatMessage, rules: BanRule[]): BanRule | undefined {
  for (const rule of rules) {
    if (
      rule.platforms !== undefined &&
      rule.platforms.length > 0 &&
      !rule.platforms.includes(message.platform)
    ) {
      continue
    }
    const matches = rule.isRegex
      ? matchesPattern(rule.pattern, true, message.author.name) ||
        matchesPattern(rule.pattern, true, message.author.displayName)
      : matchesExactName(rule.pattern, message.author.name) ||
        matchesExactName(rule.pattern, message.author.displayName)
    if (matches) {
      return rule
    }
  }
  return undefined
}

/**
 * The "ban this user" action from a message's role-gated action menu: Twitch's stable `ban` id,
 * YouTube's "Hide user on this channel" (icon `REMOVE_CIRCLE`), then — robust to icon renames —
 * any destructive non-timeout action whose label reads like a ban. Undefined when the account
 * can't moderate there (the menu only offers report/block) or the menu shape drifted.
 */
export function banAction(actions: ChatAction[]): ChatAction | undefined {
  return (
    actions.find((action) => action.id === 'ban') ??
    actions.find((action) => action.id === 'REMOVE_CIRCLE') ??
    actions.find(
      (action) =>
        action.destructive &&
        action.timeoutDurations === undefined &&
        /\b(ban|hide)\b/i.test(action.label)
    )
  )
}

/**
 * Pre-ban auto-moderation: bans a known-bad author on their first message in any chat the
 * signed-in account moderates (see {@link PrebanSettings} for the safety posture). Runs in the
 * main process on the normalized message stream, so it works with the renderer busy or hidden.
 *
 * Every decision is auditable: real bans, dry-run verdicts, missing permissions, and rate-cap
 * skips all emit a system line into the column (which also lands in the chat log when enabled)
 * plus a `[auto-mod]` console line.
 */
export class AutoMod {
  readonly #deps: AutoModDeps
  /** Authors actually banned this session, keyed `channelId|authorId`. */
  readonly #actioned = new Set<string>()
  /**
   * Authors given a dry-run verdict, consulted only while dry-run is on: the verdict isn't
   * repeated per message, but flipping dry-run off re-actions these authors for real.
   */
  readonly #dryRunVerdicts = new Set<string>()
  /** Authors whose action is still in flight, so a message burst doesn't double-ban. */
  readonly #pending = new Set<string>()
  /** Channels already told "you can't moderate here", so a match doesn't spam the column. */
  readonly #noPermsNoticed = new Set<string>()
  /**
   * Channels where the ban itself was refused with 401/403 this session (stale scopes, or the
   * mod-status check passed while the role is gone). Retrying every message there would burn the
   * shared rate cap — starving real bans everywhere — and spam an audit line per message.
   */
  readonly #permanentFailures = new Set<string>()
  #actionTimes: number[] = []
  #capNoticed = false
  #noticeCount = 0

  constructor(deps: AutoModDeps) {
    this.#deps = deps
  }

  /**
   * Forget a platform's 401/403 pauses (and its "can't moderate here" notices). Called when that
   * platform's auth changes: the pause exists because permission was gone, and the re-login the
   * failure message prescribes may have just restored it — the next match must retry.
   */
  resetPermanentFailures(platform: Platform): void {
    for (const channelId of this.#permanentFailures) {
      if (channelId.startsWith(`${platform}:`)) {
        this.#permanentFailures.delete(channelId)
      }
    }
    for (const channelId of this.#noPermsNoticed) {
      if (channelId.startsWith(`${platform}:`)) {
        this.#noPermsNoticed.delete(channelId)
      }
    }
  }

  /**
   * Consider one arriving message. Returns the (awaitable) handling promise; callers on the hot
   * event path fire-and-forget it.
   */
  onMessage(channelId: string, message: ChatMessage): Promise<void> {
    const settings = this.#deps.settings()
    if (!settings.enabled || settings.rules.length === 0) {
      return Promise.resolve()
    }
    // Never auto-action staff, our own messages, system lines, or messages we can't act on.
    if (
      message.system === true ||
      message.self === true ||
      message.author.roles.broadcaster ||
      message.author.roles.moderator ||
      message.menuToken === undefined
    ) {
      return Promise.resolve()
    }
    const rule = matchBanRule(message, settings.rules)
    if (rule === undefined) {
      return Promise.resolve()
    }
    if (this.#permanentFailures.has(channelId)) {
      return Promise.resolve()
    }
    const key = `${channelId}|${message.author.id}`
    if (this.#actioned.has(key) || this.#pending.has(key)) {
      return Promise.resolve()
    }
    if (settings.dryRun && this.#dryRunVerdicts.has(key)) {
      return Promise.resolve()
    }
    if (this.#rateLimited()) {
      // Not marked actioned: once the window clears, the author's next message retries.
      this.#noticeCapOnce(channelId, message)
      return Promise.resolve()
    }
    this.#capNoticed = false
    this.#pending.add(key)
    return this.#act(channelId, message, rule, key)
  }

  async #act(channelId: string, message: ChatMessage, rule: BanRule, key: string): Promise<void> {
    const menuToken = message.menuToken
    const who = `"${message.author.displayName}" (${message.author.name})`
    const why = `rule "${rule.pattern}"${rule.note !== undefined ? ` — ${rule.note}` : ''}`
    try {
      const actions = await this.#deps.getMessageActions(channelId, menuToken ?? '')
      const action = banAction(actions)
      if (action === undefined) {
        // Role-gated empty/viewer menu: we can't moderate here. Say so once per channel. No rate
        // slot is consumed and the author isn't marked, so gaining mod later re-actions them.
        if (!this.#noPermsNoticed.has(channelId)) {
          this.#noPermsNoticed.add(channelId)
          this.#audit(
            channelId,
            message,
            `matched ${who} (${why}) but this account can't moderate here — no action taken`
          )
        }
        return
      }
      // The cap was checked before the menu await; a burst can pass it together, so re-check at
      // claim time. The slot is claimed only here, when an action (real or dry-run) will run.
      if (this.#rateLimited()) {
        this.#noticeCapOnce(channelId, message)
        return
      }
      this.#actionTimes.push(Date.now())
      if (this.#deps.settings().dryRun) {
        this.#dryRunVerdicts.add(key)
        this.#audit(channelId, message, `DRY RUN — would ban ${who} (${why})`)
        return
      }
      await this.#deps.runMessageAction(channelId, menuToken ?? '', action.id)
      this.#actioned.add(key)
      this.#audit(channelId, message, `banned ${who} (${why})`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const statusCode = (error as { statusCode?: unknown }).statusCode
      if (statusCode === 401 || statusCode === 403) {
        // Permission is gone for good (until a re-login): stop retrying in this channel so a
        // chatty matched author can't saturate the rate cap or flood the column. Audited once.
        this.#permanentFailures.add(channelId)
        this.#audit(
          channelId,
          message,
          `failed to ban ${who} (${why}): ${detail} — auto-mod is paused for this channel until re-login or restart`
        )
        return
      }
      // Not marked actioned: a transient failure retries on the author's next message.
      this.#audit(channelId, message, `failed to ban ${who} (${why}): ${detail}`)
    } finally {
      this.#pending.delete(key)
    }
  }

  #rateLimited(): boolean {
    const now = Date.now()
    this.#actionTimes = this.#actionTimes.filter((at) => now - at < RATE_WINDOW_MS)
    return this.#actionTimes.length >= RATE_CAP
  }

  #noticeCapOnce(channelId: string, message: ChatMessage): void {
    if (this.#capNoticed) {
      return
    }
    this.#capNoticed = true
    this.#audit(
      channelId,
      message,
      `rate cap reached (${RATE_CAP}/min) — pausing auto-mod; matched "${message.author.displayName}" was NOT actioned`
    )
  }

  /** One audit line: a system message in the column (and the chat log) plus a console line. */
  #audit(channelId: string, sample: ChatMessage, text: string): void {
    console.log(`[auto-mod] ${channelId}: ${text}`)
    this.#noticeCount += 1
    this.#deps.emit({
      kind: 'message',
      channelId,
      message: {
        id: `automod-${this.#noticeCount}-${Date.now()}`,
        platform: sample.platform,
        channelId,
        timestamp: Date.now(),
        system: true,
        author: {
          id: 'auto-mod',
          name: 'auto-mod',
          displayName: '⛔ auto-mod',
          color: '#e8b339',
          badges: [],
          roles: { broadcaster: false, moderator: false }
        },
        fragments: [{ type: 'text', text }]
      }
    })
  }
}
