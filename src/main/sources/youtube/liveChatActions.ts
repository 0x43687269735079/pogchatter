import type { ChatAction, HeldAction } from '@shared/model'

/**
 * Parsing for YouTube's live-chat per-message "⋮" menu (`live_chat/get_item_context_menu`). The
 * menu YouTube returns already reflects the requesting account's role — a viewer gets report/block,
 * a moderator or the streamer also gets remove/timeout/hide-user/add-moderator. We surface only the
 * items that perform a chat action (identified by their endpoint type), dropping the navigation
 * entries YouTube's own UI mixes in ("Go to channel", "Channel Activity") that do nothing here,
 * Report (its endpoint only fetches YouTube's report form, which this client can't render — offering
 * it would silently file nothing), and the purchase call-to-action it adds to paid messages ("Buy
 * your own Super Chat") — buying is left to the official client. Action endpoints are taken from the
 * response, never hardcoded.
 *
 * Pure (no I/O) so it can be unit-tested against captured menu shapes; {@link YouTubeAuthManager}
 * fetches the menu and runs the chosen endpoint.
 */

interface RawText {
  simpleText?: string
  runs?: Array<{ text?: string }>
}
type RawEndpoint = Record<string, unknown>
interface RawMenuItemRenderer {
  text?: RawText
  icon?: { iconType?: string }
  serviceEndpoint?: RawEndpoint
  navigationEndpoint?: RawEndpoint
}
interface RawMenuItem {
  menuServiceItemRenderer?: RawMenuItemRenderer
  menuNavigationItemRenderer?: RawMenuItemRenderer
}

/**
 * Removes, bans, blocks, or times a user out — actions the UI confirms before running. Block is
 * included because {@link resolveConfirmDialog} executes its confirm button directly, bypassing the
 * confirmation dialog YouTube's own UI would show.
 */
const DESTRUCTIVE = /\b(remove|delete|ban|hide|block|timeout|time out)\b/i

/**
 * A purchase call-to-action YouTube mixes into a Super Chat / paid message's menu ("Buy your own
 * Super Chat", icon `PURCHASE_SUPER_CHAT`, whose endpoint opens YouTube's PDG buy flow). pogchatter
 * never mimics buying — donations and memberships are purchased in the official YouTube client — so
 * these are dropped from the menu and refused if invoked. The icon type is matched first
 * (locale-independent); the label is a fallback for any wording the icon doesn't cover.
 */
const PURCHASE_ICON = /PURCHASE/i
const PURCHASE_LABEL = /\b(buy|purchase)\b/i

function isPurchase(iconType: string | undefined, label: string): boolean {
  return (iconType !== undefined && PURCHASE_ICON.test(iconType)) || PURCHASE_LABEL.test(label)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const UNIT_SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400 }

/** Parse a duration label like "10 seconds" / "5 minutes" / "24 hours" to seconds, or undefined. */
function parseDurationLabel(label: string): number | undefined {
  const match = /^\s*(\d+)\s+(second|minute|hour|day)s?\s*$/i.exec(label)
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined
  }
  const unit = UNIT_SECONDS[match[2].toLowerCase()]
  return unit === undefined ? undefined : Number(match[1]) * unit
}

/**
 * A timeout action carries a `signalServiceEndpoint` that opens a "Timeout duration" dialog whose
 * `optionSelectableItemRenderer` items each hold a labelled `moderateLiveChatEndpoint` (10s … 24h).
 * Collect those as `{ seconds, params }`, so the UI offers exactly YouTube's durations and each runs
 * YouTube's own per-duration token (no client-side construction). Empty for a non-timeout endpoint.
 */
export function timeoutOptions(
  endpoint: RawEndpoint | undefined
): { seconds: number; params: string }[] {
  const options: { seconds: number; params: string }[] = []
  collectDurationOptions(endpoint, options)
  return options
}

function collectDurationOptions(node: unknown, out: { seconds: number; params: string }[]): void {
  if (!isObject(node)) {
    return
  }
  const option = node['optionSelectableItemRenderer']
  if (isObject(option)) {
    const seconds = parseDurationLabel(menuText(option['text'] as RawText))
    const submit = option['submitEndpoint']
    const moderate = isObject(submit) ? submit['moderateLiveChatEndpoint'] : undefined
    const params = isObject(moderate) ? moderate['params'] : undefined
    if (seconds !== undefined && typeof params === 'string' && params !== '') {
      out.push({ seconds, params })
    }
  }
  for (const value of Object.values(node)) {
    collectDurationOptions(value, out)
  }
}

/** The moderate `params` for a timeout endpoint's duration matching `seconds`, or undefined. */
export function timeoutParams(
  endpoint: RawEndpoint | undefined,
  seconds: number
): string | undefined {
  return timeoutOptions(endpoint).find((option) => option.seconds === seconds)?.params
}

/**
 * Endpoint keys that don't perform a chat action here: request metadata, navigation/UI entries
 * YouTube mixes into the same menu ("Go to channel", "Channel Activity"), and Report's form fetch —
 * `getReportFormEndpoint` only retrieves YouTube's report form, which this client can't render, so
 * executing it files nothing. An item whose endpoint has no key beyond these does nothing here, so
 * it's dropped — keeping the real moderation actions (including the confirm/duration sub-flows for
 * "Put user in timeout" and "Add as moderator").
 */
const NON_ACTION_ENDPOINTS = new Set([
  'clickTrackingParams',
  'commandMetadata',
  'browseEndpoint', // Go to channel
  'watchEndpoint',
  'watchPlaylistEndpoint',
  'urlEndpoint',
  'showEngagementPanelEndpoint', // Channel Activity
  'signalNavigationEndpoint',
  'getReportFormEndpoint' // Report — a form this client can't render
])

function hasActionableEndpoint(endpoint: RawEndpoint | undefined): boolean {
  return (
    endpoint !== undefined && Object.keys(endpoint).some((key) => !NON_ACTION_ENDPOINTS.has(key))
  )
}

function menuText(text: RawText | undefined): string {
  if (text === undefined) {
    return ''
  }
  if (typeof text.simpleText === 'string') {
    return text.simpleText
  }
  return (text.runs ?? []).map((run) => run.text ?? '').join('')
}

/** Depth-first search for the first value under `key` anywhere in the response (shape-agnostic). */
function findFirst(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') {
    return undefined
  }
  const record = node as Record<string, unknown>
  if (Object.hasOwn(record, key)) {
    return record[key]
  }
  for (const value of Object.values(record)) {
    const found = findFirst(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

function menuItems(data: unknown): RawMenuItem[] {
  const menu = findFirst(data, 'menuRenderer') as { items?: unknown } | undefined
  return Array.isArray(menu?.items) ? (menu.items as RawMenuItem[]) : []
}

function rendererOf(item: RawMenuItem): RawMenuItemRenderer | undefined {
  return item.menuServiceItemRenderer ?? item.menuNavigationItemRenderer
}

/**
 * The chat actions available on a message, from a raw `get_item_context_menu` response. Navigation
 * entries ("Go to channel", "Channel Activity") and Report (an un-renderable form fetch) are
 * dropped; the actions YouTube offers the account (remove / timeout / hide / add-moderator / block)
 * are kept.
 */
export function parseMenuActions(data: unknown): ChatAction[] {
  const actions: ChatAction[] = []
  for (const item of menuItems(data)) {
    const renderer = rendererOf(item)
    const id = renderer?.icon?.iconType
    const label = menuText(renderer?.text)
    const endpoint = renderer?.serviceEndpoint ?? renderer?.navigationEndpoint
    if (
      renderer === undefined ||
      id === undefined ||
      id === '' ||
      label === '' ||
      isPurchase(id, label) ||
      !hasActionableEndpoint(endpoint)
    ) {
      continue
    }
    const action: ChatAction = { id, label, destructive: DESTRUCTIVE.test(label) }
    const durations = timeoutOptions(endpoint)
    if (durations.length > 0) {
      action.timeoutDurations = durations.map((option) => option.seconds)
    }
    actions.push(action)
  }
  return actions
}

/** The raw action endpoint for a chosen action id, or undefined if it's no longer in the menu. */
export function findActionEndpoint(data: unknown, actionId: string): RawEndpoint | undefined {
  for (const item of menuItems(data)) {
    const renderer = rendererOf(item)
    if (renderer?.icon?.iconType === actionId) {
      // Never resolve a purchase CTA, even if one is somehow requested — buying isn't ours to do.
      if (isPurchase(actionId, menuText(renderer.text))) {
        return undefined
      }
      return renderer.serviceEndpoint ?? renderer.navigationEndpoint
    }
  }
  return undefined
}

/**
 * The `live_chat/moderate` params token on a moderation endpoint (remove / timeout / hide-user /
 * unhide / block's resolved confirm button), or undefined for a non-moderation endpoint (a timeout's
 * duration dialog, an unresolved confirm dialog). The web client POSTs this token to
 * `/youtubei/v1/live_chat/moderate` — it already encodes the target message/user and the action — so
 * the client replays it rather than building one.
 */
export function moderationParams(endpoint: RawEndpoint | undefined): string | undefined {
  const moderate = endpoint?.['moderateLiveChatEndpoint'] as { params?: unknown } | undefined
  const params = moderate?.params
  return typeof params === 'string' && params !== '' ? params : undefined
}

/**
 * Resolve an endpoint through its confirmation dialog, if it carries one. Block's menu endpoint is a
 * `confirmDialogEndpoint` that only *opens* a "Block this person?" dialog — executing it verbatim
 * performs nothing (it has no api_url); the real action (a `moderateLiveChatEndpoint` for Block)
 * sits on the dialog's confirm button. Returns the confirm button's endpoint, the input unchanged
 * when there is no confirm dialog, or undefined when the dialog has no usable confirm button (shape
 * drift — the caller must refuse rather than silently do nothing).
 */
export function resolveConfirmDialog(endpoint: RawEndpoint): RawEndpoint | undefined {
  const dialog = endpoint['confirmDialogEndpoint']
  if (dialog === undefined) {
    return endpoint
  }
  const confirm = findFirst(dialog, 'confirmButton')
  const renderer = isObject(confirm) ? confirm['buttonRenderer'] : undefined
  if (!isObject(renderer)) {
    return undefined
  }
  const action = renderer['serviceEndpoint'] ?? renderer['navigationEndpoint']
  return isObject(action) ? action : undefined
}

interface RawButtonRenderer {
  text?: RawText
  icon?: { iconType?: string }
  serviceEndpoint?: RawEndpoint
  navigationEndpoint?: RawEndpoint
  command?: RawEndpoint
}

/** The endpoint a button replays — YouTube puts it under any of these keys. */
function buttonEndpoint(renderer: RawButtonRenderer): RawEndpoint | undefined {
  return renderer.serviceEndpoint ?? renderer.navigationEndpoint ?? renderer.command
}

/** Encode a raw button endpoint into the opaque token the renderer hands back to runHeldAction. */
function encodeHeldToken(endpoint: RawEndpoint): string {
  return Buffer.from(JSON.stringify(endpoint), 'utf8').toString('base64')
}

/** Decode a held-action token back to its raw endpoint, or undefined if malformed. */
export function decodeHeldToken(token: string): RawEndpoint | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The inline approve/remove actions on a YouTube automod "held for review" message, from its raw
 * `moderationButtons` (each a `buttonRenderer` with a label, icon, and the endpoint to replay). The
 * endpoint is replayed verbatim later (see {@link decodeHeldToken} + the manager), so this never
 * constructs a moderation call — it only carries YouTube's own. A purchase CTA (should one ever
 * appear) is dropped, like the context menu. `buttons` is untyped raw JSON.
 */
export function parseHeldActions(buttons: unknown): HeldAction[] {
  const actions: HeldAction[] = []
  if (!Array.isArray(buttons)) {
    return actions
  }
  buttons.forEach((button, index) => {
    const renderer = isObject(button) ? (button['buttonRenderer'] as RawButtonRenderer) : undefined
    const endpoint = isObject(renderer) ? buttonEndpoint(renderer) : undefined
    const label = menuText(renderer?.text)
    if (renderer === undefined || endpoint === undefined || label === '') {
      return
    }
    if (isPurchase(renderer.icon?.iconType, label)) {
      return
    }
    actions.push({
      id: renderer.icon?.iconType ?? `held-${index}`,
      label,
      destructive: DESTRUCTIVE.test(label),
      token: encodeHeldToken(endpoint)
    })
  })
  return actions
}

/**
 * A `moderateLiveChatEndpoint.params` token anywhere inside an endpoint. A held message's
 * approve/remove button may carry the moderate endpoint directly or wrapped (e.g. in a command
 * executor), so this searches the whole endpoint rather than only its top level. Undefined when the
 * endpoint is not a moderation call (it's then replayed verbatim).
 */
export function deepModerationParams(endpoint: RawEndpoint | undefined): string | undefined {
  const moderate = findFirst(endpoint, 'moderateLiveChatEndpoint')
  const params = isObject(moderate) ? moderate['params'] : undefined
  return typeof params === 'string' && params !== '' ? params : undefined
}
