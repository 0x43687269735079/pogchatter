import { describe, expect, it } from 'vitest'
import {
  decodeHeldToken,
  deepModerationParams,
  findActionEndpoint,
  moderationParams,
  parseHeldActions,
  parseMenuActions,
  resolveConfirmDialog,
  timeoutOptions,
  timeoutParams
} from '@main/sources/youtube/liveChatActions'

function item(
  iconType: string,
  label: string,
  endpoint: unknown,
  kind = 'menuServiceItemRenderer'
) {
  return {
    [kind]: { text: { runs: [{ text: label }] }, icon: { iconType }, serviceEndpoint: endpoint }
  }
}

/** A get_item_context_menu response with the menu nested under an arbitrary wrapper. */
function menu(...items: unknown[]) {
  return {
    liveChatItemContextMenuSupportedRenderers: { menuRenderer: { items } }
  }
}

/** The real timeout shape: a signal-service endpoint opening a dialog of labelled moderate params. */
function timeoutEndpoint(durations: { label: string; params: string }[]): unknown {
  return {
    signalServiceEndpoint: {
      signal: 'CLIENT_SIGNAL',
      actions: [
        {
          openPopupAction: {
            popup: {
              showActionDialogRenderer: {
                body: {
                  showActionDialogContentRenderer: {
                    content: [
                      {
                        formRenderer: {
                          fields: [
                            {
                              optionsRenderer: {
                                items: durations.map((d) => ({
                                  optionSelectableItemRenderer: {
                                    text: { simpleText: d.label },
                                    submitEndpoint: {
                                      moderateLiveChatEndpoint: { params: d.params }
                                    }
                                  }
                                }))
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    }
  }
}

const TIMEOUT_DIALOG = timeoutEndpoint([
  { label: '10 seconds', params: 'to-10' },
  { label: '5 minutes', params: 'to-300' },
  { label: '24 hours', params: 'to-86400' }
])

// Mirrors the captured moderator menu (capture moderation/5-get-item-context-rightclick-response).
const moderatorMenu = menu(
  item('FLAG', 'Report', { getReportFormEndpoint: {}, commandMetadata: {} }),
  item('DELETE', 'Remove', {
    moderateLiveChatEndpoint: { params: 'del-token' },
    commandMetadata: {}
  }),
  item('HOURGLASS', 'Put user in timeout', TIMEOUT_DIALOG),
  item('REMOVE_CIRCLE', 'Hide user on this channel', {
    moderateLiveChatEndpoint: { params: 'ban-token' }
  })
)

/**
 * The viewer Block endpoint as really captured (capture purchase-endpoints/5-…-response): a
 * confirm dialog whose confirm button carries the actionable moderate endpoint.
 */
const BLOCK_ENDPOINT = {
  commandMetadata: {},
  confirmDialogEndpoint: {
    content: {
      confirmDialogRenderer: {
        title: { runs: [{ text: 'Block this person?' }] },
        confirmButton: {
          buttonRenderer: {
            text: { simpleText: 'Block' },
            serviceEndpoint: {
              commandMetadata: {
                webCommandMetadata: { apiUrl: '/youtubei/v1/live_chat/moderate' }
              },
              moderateLiveChatEndpoint: { params: 'block-token' }
            }
          }
        },
        cancelButton: { buttonRenderer: { text: { simpleText: 'Cancel' } } }
      }
    }
  }
}

const blockItem = {
  menuNavigationItemRenderer: {
    text: { runs: [{ text: 'Block' }] },
    icon: { iconType: 'NOT_INTERESTED' },
    navigationEndpoint: BLOCK_ENDPOINT
  }
}

const viewerMenu = menu(item('FLAG', 'Report', { getReportFormEndpoint: {} }), blockItem)

describe('parseMenuActions', () => {
  it('lists every actionable menu item with id and label', () => {
    const actions = parseMenuActions(moderatorMenu)
    expect(actions.map((a) => a.id)).toEqual(['DELETE', 'HOURGLASS', 'REMOVE_CIRCLE'])
    expect(actions.map((a) => a.label)).toEqual([
      'Remove',
      'Put user in timeout',
      'Hide user on this channel'
    ])
  })

  it("never offers Report — its endpoint only fetches a form this client can't render", () => {
    expect(parseMenuActions(moderatorMenu).some((a) => a.id === 'FLAG')).toBe(false)
    expect(parseMenuActions(viewerMenu).map((a) => a.label)).toEqual(['Block'])
  })

  it("attaches the timeout action's duration options (seconds) from the dialog", () => {
    const byLabel = Object.fromEntries(
      parseMenuActions(moderatorMenu).map((a) => [a.label, a.timeoutDurations])
    )
    expect(byLabel['Put user in timeout']).toEqual([10, 300, 86400])
    expect(byLabel['Remove']).toBeUndefined()
    expect(byLabel['Hide user on this channel']).toBeUndefined()
  })

  it('flags remove/timeout/ban/block-style actions as destructive', () => {
    const byLabel = Object.fromEntries(
      parseMenuActions(moderatorMenu).map((a) => [a.label, a.destructive])
    )
    expect(byLabel['Remove']).toBe(true)
    expect(byLabel['Put user in timeout']).toBe(true)
    expect(byLabel['Hide user on this channel']).toBe(true)
    // Block runs without YouTube's own confirm dialog here, so the UI must confirm it.
    expect(parseMenuActions(viewerMenu)).toEqual([
      { id: 'NOT_INTERESTED', label: 'Block', destructive: true }
    ])
  })

  it('reads an action carried on a menuNavigationItemRenderer too', () => {
    const actions = parseMenuActions(menu(blockItem))
    expect(actions).toEqual([{ id: 'NOT_INTERESTED', label: 'Block', destructive: true }])
  })

  it('drops items with no chat action (Go to channel, Channel Activity)', () => {
    const actions = parseMenuActions(
      menu(
        item('PERSON', 'Go to channel', { urlEndpoint: {} }, 'menuNavigationItemRenderer'),
        item('WATCH_HISTORY', 'Channel Activity', { commandMetadata: {} }), // no inner endpoint
        item('DELETE', 'Remove', { moderateLiveChatEndpoint: { params: 'x' } })
      )
    )
    expect(actions.map((a) => a.label)).toEqual(['Remove'])
  })

  it('drops the "Buy your own Super Chat" purchase CTA on a paid message', () => {
    // The real Super Chat menu: icon PURCHASE_SUPER_CHAT, a commandExecutorCommand opening the buy flow.
    const actions = parseMenuActions(
      menu(
        item('PURCHASE_SUPER_CHAT', 'Buy your own Super Chat', { commandExecutorCommand: {} }),
        item('FLAG', 'Report', { getReportFormEndpoint: {} }),
        blockItem
      )
    )
    expect(actions.map((a) => a.label)).toEqual(['Block'])
  })

  it('drops a purchase CTA by its icon type even if the label is localized', () => {
    const actions = parseMenuActions(
      menu(
        item('PURCHASE_SUPER_CHAT', 'Achète ton propre Super Chat', { commandExecutorCommand: {} })
      )
    )
    expect(actions).toEqual([])
  })

  it('refuses to resolve the purchase CTA even if its id is requested', () => {
    const data = menu(
      item('PURCHASE_SUPER_CHAT', 'Buy your own Super Chat', { commandExecutorCommand: {} })
    )
    expect(findActionEndpoint(data, 'PURCHASE_SUPER_CHAT')).toBeUndefined()
  })

  it('keeps an action whose endpoint is a confirm/sub-flow (timeout, add moderator)', () => {
    // These items don't carry a direct moderate endpoint (timeout opens a duration picker), so the
    // filter must keep any item with a non-navigation inner endpoint.
    const actions = parseMenuActions(
      menu(
        item('HOURGLASS', 'Put user in timeout', { confirmDialogEndpoint: {} }),
        item('ADD_MODERATOR', 'Add as moderator', { signalServiceEndpoint: {} })
      )
    )
    expect(actions.map((a) => a.label)).toEqual(['Put user in timeout', 'Add as moderator'])
  })

  it('returns [] for an empty, garbage, or menu-less response', () => {
    expect(parseMenuActions(undefined)).toEqual([])
    expect(parseMenuActions({})).toEqual([])
    expect(parseMenuActions({ foo: { bar: 1 } })).toEqual([])
  })

  it('skips items missing an icon type or label', () => {
    const actions = parseMenuActions(
      menu(
        { menuServiceItemRenderer: { text: { runs: [{ text: 'No icon' }] } } },
        { menuServiceItemRenderer: { icon: { iconType: 'DELETE' } } },
        item('DELETE', 'Remove', { moderateLiveChatEndpoint: { params: 'x' } })
      )
    )
    expect(actions).toEqual([{ id: 'DELETE', label: 'Remove', destructive: true }])
  })
})

describe('findActionEndpoint', () => {
  it('returns the chosen action endpoint verbatim', () => {
    expect(findActionEndpoint(moderatorMenu, 'DELETE')).toEqual({
      moderateLiveChatEndpoint: { params: 'del-token' },
      commandMetadata: {}
    })
  })

  it('returns undefined for an action no longer in the menu', () => {
    expect(findActionEndpoint(moderatorMenu, 'NOPE')).toBeUndefined()
  })
})

describe('moderationParams', () => {
  it('extracts the moderate token from a direct remove/hide endpoint', () => {
    expect(moderationParams(findActionEndpoint(moderatorMenu, 'DELETE'))).toBe('del-token')
    expect(moderationParams(findActionEndpoint(moderatorMenu, 'REMOVE_CIRCLE'))).toBe('ban-token')
  })

  it("is undefined for report, block's unresolved dialog, a timeout dialog, and missing input", () => {
    expect(moderationParams(findActionEndpoint(moderatorMenu, 'FLAG'))).toBeUndefined()
    expect(moderationParams(findActionEndpoint(viewerMenu, 'NOT_INTERESTED'))).toBeUndefined()
    // A timeout carries its tokens inside a dialog, not directly on the endpoint.
    expect(moderationParams(findActionEndpoint(moderatorMenu, 'HOURGLASS'))).toBeUndefined()
    expect(moderationParams(undefined)).toBeUndefined()
    expect(moderationParams({ moderateLiveChatEndpoint: { params: '' } })).toBeUndefined()
  })
})

describe('resolveConfirmDialog', () => {
  it('returns an endpoint without a confirm dialog unchanged', () => {
    const endpoint = { moderateLiveChatEndpoint: { params: 'del-token' } }
    expect(resolveConfirmDialog(endpoint)).toBe(endpoint)
  })

  it("resolves Block's confirm dialog to the confirm button's moderate endpoint", () => {
    const resolved = resolveConfirmDialog(BLOCK_ENDPOINT)
    expect(moderationParams(resolved)).toBe('block-token')
  })

  it('is undefined when the dialog has no confirm button (shape drift)', () => {
    expect(
      resolveConfirmDialog({ confirmDialogEndpoint: { content: { confirmDialogRenderer: {} } } })
    ).toBeUndefined()
  })

  it('is undefined when the confirm button carries no endpoint', () => {
    expect(
      resolveConfirmDialog({
        confirmDialogEndpoint: {
          content: {
            confirmDialogRenderer: {
              confirmButton: { buttonRenderer: { text: { simpleText: 'Block' } } }
            }
          }
        }
      })
    ).toBeUndefined()
  })
})

describe('timeoutOptions / timeoutParams', () => {
  const endpoint = findActionEndpoint(moderatorMenu, 'HOURGLASS')

  it('reads each duration (seconds) and its moderate token from the timeout dialog', () => {
    expect(timeoutOptions(endpoint)).toEqual([
      { seconds: 10, params: 'to-10' },
      { seconds: 300, params: 'to-300' },
      { seconds: 86400, params: 'to-86400' }
    ])
  })

  it('returns the token for a chosen duration, or undefined for an unavailable one', () => {
    expect(timeoutParams(endpoint, 10)).toBe('to-10')
    expect(timeoutParams(endpoint, 86400)).toBe('to-86400')
    expect(timeoutParams(endpoint, 12345)).toBeUndefined()
  })

  it('is empty for a non-timeout endpoint', () => {
    expect(timeoutOptions(findActionEndpoint(moderatorMenu, 'DELETE'))).toEqual([])
    expect(timeoutOptions(undefined)).toEqual([])
  })
})

describe('parseHeldActions', () => {
  const buttons = [
    {
      buttonRenderer: {
        text: { simpleText: 'Allow' },
        icon: { iconType: 'CHECK' },
        serviceEndpoint: { moderateLiveChatEndpoint: { params: 'APP' } }
      }
    },
    {
      buttonRenderer: {
        text: { simpleText: 'Remove' },
        icon: { iconType: 'DELETE' },
        // The moderate endpoint may be wrapped (e.g. in a command executor) — deepModerationParams finds it.
        serviceEndpoint: {
          commandExecutorCommand: { commands: [{ moderateLiveChatEndpoint: { params: 'REM' } }] }
        }
      }
    }
  ]

  it('parses label/destructive/id and round-trips the endpoint through the token', () => {
    const actions = parseHeldActions(buttons)
    expect(actions.map((action) => [action.label, action.destructive, action.id])).toEqual([
      ['Allow', false, 'CHECK'],
      ['Remove', true, 'DELETE']
    ])
    expect(deepModerationParams(decodeHeldToken(actions[0]?.token ?? ''))).toBe('APP')
    expect(deepModerationParams(decodeHeldToken(actions[1]?.token ?? ''))).toBe('REM')
  })

  it('flags a destructive action by its locale-independent icon, not just an English label', () => {
    // A non-English moderator account gets a localized "Remove" label; the DELETE icon is stable.
    const actions = parseHeldActions([
      {
        buttonRenderer: {
          text: { simpleText: 'Entfernen' },
          icon: { iconType: 'DELETE' },
          serviceEndpoint: { moderateLiveChatEndpoint: { params: 'REM' } }
        }
      }
    ])
    expect(actions[0]?.destructive).toBe(true)
  })

  it('falls back to an index id, replays a non-moderate endpoint verbatim, and drops endpoint-less buttons', () => {
    const actions = parseHeldActions([
      {},
      { buttonRenderer: { text: { simpleText: 'No endpoint' } } },
      {
        buttonRenderer: {
          text: { simpleText: 'Open' },
          navigationEndpoint: { urlEndpoint: { url: 'x' } }
        }
      }
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0]?.id).toBe('held-2')
    // No moderate params → the executor replays the endpoint verbatim.
    expect(deepModerationParams(decodeHeldToken(actions[0]?.token ?? ''))).toBeUndefined()
  })

  it('ignores a non-array and never throws', () => {
    expect(parseHeldActions(undefined)).toEqual([])
    expect(parseHeldActions({})).toEqual([])
  })

  it('decodeHeldToken returns undefined on a malformed token', () => {
    expect(decodeHeldToken('@@@ not valid base64 json @@@')).toBeUndefined()
  })
})
