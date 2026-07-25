import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import {
  normalizeAction,
  parseChannelActivity,
  parseReplyThread,
  unknownActionKeys,
  type RawAction
} from '@main/sources/youtube/normalize'

function textMessage(runs: unknown[]): RawAction {
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: 'm1',
          authorName: { simpleText: 'Alice' },
          timestampUsec: '1700000000000000',
          message: { runs }
        }
      }
    }
  } as RawAction
}

describe('YouTube message fragments', () => {
  it('keeps a standard emoji as its unicode text', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([{ emoji: { emojiId: '❗', isCustomEmoji: false } }])
    )
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: '❗' }])
  })

  it('shows the full link from a truncated link run (unwrapping the redirect)', () => {
    const redirect =
      'https://www.youtube.com/redirect?event=live_chat&redir_token=ABC&q=https%3A%2F%2Flink.example.com%2Fmorningcoffee-yt'
    const { messages } = normalizeAction(
      'src',
      textMessage([
        { text: 'check ' },
        {
          text: 'https://link.example.com/morning...',
          navigationEndpoint: { urlEndpoint: { url: redirect } }
        }
      ])
    )
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'check ' },
      { type: 'text', text: 'https://link.example.com/morningcoffee-yt' }
    ])
  })

  it('keeps a non-redirect link URL as-is, and plain text untouched', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([
        {
          text: 'support...',
          navigationEndpoint: { urlEndpoint: { url: 'https://example.org/help' } }
        },
        { text: ' and plain' }
      ])
    )
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'https://example.org/help' },
      { type: 'text', text: ' and plain' }
    ])
  })

  it('interleaves text and standard emoji in order', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([
        { text: 'hi ' },
        { emoji: { emojiId: '🔥', isCustomEmoji: false } },
        { text: '!' }
      ])
    )
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'text', text: '🔥' },
      { type: 'text', text: '!' }
    ])
  })

  it('renders a custom emoji as an emote with its image', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([
        {
          emoji: {
            emojiId: 'UCabc/kek',
            isCustomEmoji: true,
            shortcuts: [':kek:'],
            image: { thumbnails: [{ url: 'http://e/kek.png', width: 24 }] }
          }
        }
      ])
    )
    expect(messages[0]?.fragments).toEqual([
      {
        type: 'emote',
        code: ':kek:',
        url: 'http://e/kek.png',
        provider: 'youtube',
        zeroWidth: false,
        animated: false
      }
    ])
  })
})

/** An id-less text message (forces the fallback id), with controllable author/timestamp/text. */
function idlessMessage(text: string, author?: string, timestampUsec?: string): RawAction {
  const renderer: Record<string, unknown> = {
    authorName: { simpleText: 'Alice' },
    message: { runs: [{ text }] }
  }
  if (author !== undefined) {
    renderer['authorExternalChannelId'] = author
  }
  if (timestampUsec !== undefined) {
    renderer['timestampUsec'] = timestampUsec
  }
  return { addChatItemAction: { item: { liveChatTextMessageRenderer: renderer } } } as RawAction
}

function idOf(action: RawAction): string | undefined {
  return normalizeAction('src', action).messages[0]?.id
}

describe('YouTube fallback message id', () => {
  it('is identical across re-sends of the same item (so dedup catches it)', () => {
    const a = idOf(idlessMessage('hello', 'UCauthor', '1700000000000000'))
    const b = idOf(idlessMessage('hello', 'UCauthor', '1700000000000000'))
    expect(a).toBe(b)
  })

  it('differs for distinct messages at the same author and timestamp', () => {
    const ts = '1700000000000000'
    const a = idOf(idlessMessage('hello', 'UCauthor', ts))
    const b = idOf(idlessMessage('goodbye', 'UCauthor', ts))
    expect(a).not.toBe(b)
  })

  it('differs for the same text from different authors', () => {
    const a = idOf(idlessMessage('gg', 'UCalice', '1700000000000000'))
    const b = idOf(idlessMessage('gg', 'UCbob', '1700000000000000'))
    expect(a).not.toBe(b)
  })

  it('is deterministic even without a timestamp (no Date.now in the id)', () => {
    const a = idOf(idlessMessage('no timestamp here', 'UCauthor'))
    const b = idOf(idlessMessage('no timestamp here', 'UCauthor'))
    expect(a).toBe(b)
  })
})

describe('YouTube deletions map to clears', () => {
  it('marks a single message deleted (markChatItemAsDeletedAction)', () => {
    const { clears } = normalizeAction('src', {
      markChatItemAsDeletedAction: { targetItemId: 'msg-1' }
    } as RawAction)
    expect(clears).toEqual([{ messageId: 'msg-1' }])
  })

  it('removes a single message (removeChatItemAction)', () => {
    const { clears } = normalizeAction('src', {
      removeChatItemAction: { targetItemId: 'msg-2' }
    } as RawAction)
    expect(clears).toEqual([{ messageId: 'msg-2' }])
  })

  it('bans an author by mark (markChatItemsByAuthorAsDeletedAction)', () => {
    const { clears } = normalizeAction('src', {
      markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCspammer' }
    } as RawAction)
    expect(clears).toEqual([{ userId: 'UCspammer' }])
  })

  it('bans an author by remove (removeChatItemByAuthorAction)', () => {
    const { clears } = normalizeAction('src', {
      removeChatItemByAuthorAction: { externalChannelId: 'UCbanned' }
    } as RawAction)
    expect(clears).toEqual([{ userId: 'UCbanned' }])
  })
})

describe('YouTube message menu token', () => {
  it('captures the context-menu params token when present', () => {
    const action = {
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id: 'm1',
            authorName: { simpleText: 'Alice' },
            message: { runs: [{ text: 'hi' }] },
            contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'TOKEN123' } }
          }
        }
      }
    } as RawAction
    expect(normalizeAction('src', action).messages[0]?.menuToken).toBe('TOKEN123')
  })

  it('leaves menuToken undefined when there is no context menu', () => {
    const { messages } = normalizeAction('src', textMessage([{ text: 'hi' }]))
    expect(messages[0]?.menuToken).toBeUndefined()
  })
})

describe('YouTube proprietary emoji rendering', () => {
  it('renders a :face-...: proprietary emoji as an image emote', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([
        {
          emoji: {
            emojiId: 'UCkszU2WH9gy1mb0dV-11UJg/oPgfY_DoKfSXkNAPq8-AgAo',
            shortcuts: [':face-blue-smiling:'],
            image: { thumbnails: [{ url: 'http://e/face.png', width: 48 }] }
          }
        }
      ])
    )
    expect(messages[0]?.fragments).toEqual([
      {
        type: 'emote',
        code: ':face-blue-smiling:',
        url: 'http://e/face.png',
        provider: 'youtube',
        zeroWidth: false,
        animated: false
      }
    ])
  })

  it('keeps a standard unicode emoji (with a noto image) as text', () => {
    const { messages } = normalizeAction(
      'src',
      textMessage([
        {
          text: '🇬🇧',
          emoji: {
            emojiId: '🇬🇧',
            image: { thumbnails: [{ url: 'http://noto/gb.png', width: 72 }] }
          }
        }
      ])
    )
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: '🇬🇧' }])
  })
})

/** A text message carrying the "before content" chip YouTube adds to a reply-to-a-Super-Chat. */
function donationReplyMessage(
  donorHandle: string,
  tag = 'PAreply_thread',
  params?: string
): RawAction {
  const showEngagementPanelEndpoint: Record<string, unknown> = { identifier: { tag } }
  if (params !== undefined) {
    showEngagementPanelEndpoint['globalConfiguration'] = { params }
  }
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: 'r1',
          authorName: { simpleText: 'Replier' },
          message: { runs: [{ text: 'warm croc' }] },
          beforeContentButtons: [
            {
              buttonViewModel: {
                title: donorHandle,
                onTap: { innertubeCommand: { showEngagementPanelEndpoint } }
              }
            }
          ]
        }
      }
    }
  } as RawAction
}

describe('YouTube donation replies', () => {
  it('threads a reply to a Super Chat onto the donor as its parent', () => {
    const { messages } = normalizeAction('src', donationReplyMessage('@nonixium'))
    expect(messages[0]?.reply).toEqual({
      parentId: '',
      parentAuthor: '@nonixium',
      parentText: ''
    })
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: 'warm croc' }])
  })

  it('captures the reply-thread token so the thread can be opened', () => {
    const { messages } = normalizeAction(
      'src',
      donationReplyMessage('@nonixium', 'PAreply_thread', 'TOKEN')
    )
    expect(messages[0]?.reply?.threadToken).toBe('TOKEN')
  })

  it('leaves an ordinary message (no reply chip) without a reply', () => {
    const { messages } = normalizeAction('src', textMessage([{ text: 'hi' }]))
    expect(messages[0]?.reply).toBeUndefined()
  })

  it('ignores a before-content chip that is not a reply thread', () => {
    const { messages } = normalizeAction(
      'src',
      donationReplyMessage('@someone', 'PAsomething_else')
    )
    expect(messages[0]?.reply).toBeUndefined()
  })
})

describe('parseReplyThread', () => {
  function panel(): unknown {
    return {
      content: {
        engagementPanelSectionListRenderer: {
          content: {
            sectionListRenderer: {
              header: {
                liveChatItemDisplayRenderer: {
                  item: {
                    liveChatPaidMessageRenderer: {
                      id: 'sc1',
                      authorName: { simpleText: '@nonixium' },
                      timestampUsec: '1780960616391332',
                      purchaseAmountText: { simpleText: '$5.00' },
                      message: { runs: [{ text: 'hug Nitya' }] },
                      bodyBackgroundColor: 4280150454
                    }
                  }
                }
              },
              contents: [
                {
                  liveChatItemDisplayListRenderer: {
                    items: [
                      {
                        liveChatTextMessageRenderer: {
                          id: 'rep1',
                          authorName: { simpleText: '@Egg' },
                          timestampUsec: '1780960622639548',
                          message: { runs: [{ text: 'mhm' }] }
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

  it('returns the donation first, then its replies', () => {
    const messages = parseReplyThread('src', panel())
    expect(messages.map((message) => message.id)).toEqual(['sc1', 'rep1'])
    expect(messages[0]?.highlight?.kind).toBe('superchat')
    expect(messages[0]?.highlight?.displayAmount).toBe('$5.00')
    expect(messages[1]?.fragments).toEqual([{ type: 'text', text: 'mhm' }])
  })

  it('returns an empty list on an unexpected shape', () => {
    expect(parseReplyThread('src', {})).toEqual([])
    expect(parseReplyThread('src', undefined)).toEqual([])
  })
})

describe('unknownActionKeys (parse health)', () => {
  it('returns [] for every action type the normalizer consumes', () => {
    const known = [
      textMessage([{ text: 'hi' }]),
      { markChatItemAsDeletedAction: { targetItemId: 'm1' } },
      { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCx' } },
      { removeChatItemAction: { targetItemId: 'm2' } },
      { removeChatItemByAuthorAction: { externalChannelId: 'UCy' } }
    ] as RawAction[]
    expect(known.flatMap((action) => unknownActionKeys(action))).toEqual([])
  })

  it('ignores clickTrackingParams metadata riding alongside a known action', () => {
    const action = {
      clickTrackingParams: 'tracking',
      removeChatItemAction: { targetItemId: 'm1' }
    } as RawAction
    expect(unknownActionKeys(action)).toEqual([])
  })

  it('names an unknown top-level action type', () => {
    const action = { addBannerToLiveChatCommand: { bannerRenderer: {} } } as RawAction
    expect(unknownActionKeys(action)).toEqual(['addBannerToLiveChatCommand'])
  })

  it('names an unknown renderer inside addChatItemAction', () => {
    const action = {
      addChatItemAction: { item: { liveChatSomeNewRenderer: { id: 'p1' } } }
    } as unknown as RawAction
    expect(unknownActionKeys(action)).toEqual(['liveChatSomeNewRenderer'])
  })

  it('treats recognized-but-unrendered informational items as known (no false alarm)', () => {
    // Seen on nearly every chat open: the "welcome to live chat" banner and message placeholders.
    const engagement = {
      addChatItemAction: { item: { liveChatViewerEngagementMessageRenderer: { id: 'e1' } } }
    } as unknown as RawAction
    const placeholder = {
      addChatItemAction: { item: { liveChatPlaceholderItemRenderer: { id: 'p1' } } }
    } as RawAction
    expect(unknownActionKeys(engagement)).toEqual([])
    expect(unknownActionKeys(placeholder)).toEqual([])
  })

  it('looks through replayChatItemAction at the wrapped actions', () => {
    const known = {
      replayChatItemAction: { actions: [{ removeChatItemAction: { targetItemId: 'm1' } }] }
    } as RawAction
    const unknown = {
      replayChatItemAction: { actions: [{ someNewAction: {} }] }
    } as unknown as RawAction
    expect(unknownActionKeys(known)).toEqual([])
    expect(unknownActionKeys(unknown)).toEqual(['someNewAction'])
  })

  it('treats the Moderation activity stream control actions as known (no false alarm)', () => {
    // Arrive once when the reader enters the "Moderation activity" continuation: the mode
    // acknowledgement and its "Moderation activity on" toast. Neither is a chat item.
    const toggle = {
      toggleLiveChatModerationActivityCommand: { hack: true, filtered: false }
    } as unknown as RawAction
    const toast = { liveChatAddToToastAction: { item: {} } } as unknown as RawAction
    expect(unknownActionKeys(toggle)).toEqual([])
    expect(unknownActionKeys(toast)).toEqual([])
  })
})

function membership(renderer: Record<string, unknown>): RawAction {
  return {
    addChatItemAction: { item: { liveChatMembershipItemRenderer: renderer } }
  } as RawAction
}

describe('YouTube membership messages', () => {
  it('keeps the member milestone-chat text and the milestone header', () => {
    const { messages } = normalizeAction(
      'src',
      membership({
        id: 'mem1',
        authorName: { simpleText: 'Alice' },
        timestampUsec: '1700000000000000',
        headerPrimaryText: { simpleText: 'Member for 6 months' },
        message: { runs: [{ text: 'love the streams!' }] }
      })
    )
    const message = messages[0]
    // notAPurchase marks a milestone from an existing member: the line recurs monthly and no money
    // changes hands, so revenue accounting must not count it as a new membership each time.
    expect(message?.highlight).toEqual({
      kind: 'membership',
      headerText: 'Member for 6 months',
      notAPurchase: true
    })
    expect(message?.fragments).toEqual([{ type: 'text', text: 'love the streams!' }])
    expect(message?.system).toBe(true)
  })

  it('falls back to the welcome subtext and no body for a new member', () => {
    const { messages } = normalizeAction(
      'src',
      membership({
        id: 'mem2',
        authorName: { simpleText: 'Bob' },
        headerSubtext: { simpleText: 'Welcome!' }
      })
    )
    const message = messages[0]
    expect(message?.highlight).toEqual({ kind: 'membership', headerText: 'Welcome!' })
    expect(message?.fragments).toEqual([])
  })

  it('prefers the milestone header over the subtext when both are present', () => {
    const { messages } = normalizeAction(
      'src',
      membership({
        id: 'mem3',
        authorName: { simpleText: 'Cara' },
        headerPrimaryText: { simpleText: 'Member for 12 months' },
        headerSubtext: { simpleText: 'Welcome!' }
      })
    )
    expect(messages[0]?.highlight?.headerText).toBe('Member for 12 months')
  })

  it('renders a custom member emoji in the milestone-chat body', () => {
    const { messages } = normalizeAction(
      'src',
      membership({
        id: 'mem4',
        authorName: { simpleText: 'Dee' },
        headerPrimaryText: { simpleText: 'Member for 3 months' },
        message: {
          runs: [
            { text: 'gg ' },
            {
              emoji: {
                emojiId: 'UCabc/heart',
                isCustomEmoji: true,
                shortcuts: [':heart:'],
                image: { thumbnails: [{ url: 'http://e/heart.png', width: 48 }] }
              }
            }
          ]
        }
      })
    )
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'gg ' },
      {
        type: 'emote',
        code: ':heart:',
        url: 'http://e/heart.png',
        provider: 'youtube',
        zeroWidth: false,
        animated: false
      }
    ])
  })
})

// Mirrors the real auto-mod renderer (capture auto-moderation/1-...-response): Show/Hide carry a
// `text`, while the per-author inline buttons carry only an icon + accessibility label, and the
// wrapped item (not the outer renderer) holds the ⋮ context menu.
function modButton(label: string, params: string): unknown {
  return {
    buttonRenderer: {
      text: { simpleText: label },
      serviceEndpoint: { moderateLiveChatEndpoint: { params } }
    }
  }
}
function inlineButton(iconType: string, label: string, params: string): unknown {
  return {
    buttonRenderer: {
      icon: { iconType },
      accessibility: { label },
      tooltip: label,
      serviceEndpoint: { moderateLiveChatEndpoint: { params } }
    }
  }
}
function heldAction(overrides: Record<string, unknown> = {}): RawAction {
  return {
    addChatItemAction: {
      item: {
        liveChatAutoModMessageRenderer: {
          id: 'held-1',
          timestampUsec: '1700000000000000',
          headerText: { runs: [{ text: 'This message is held for review.' }] },
          autoModeratedItem: {
            liveChatTextMessageRenderer: {
              id: 'held-1',
              authorName: { simpleText: 'Spammer' },
              authorExternalChannelId: 'UCspam',
              timestampUsec: '1700000000000000',
              message: { runs: [{ text: 'questionable' }] },
              contextMenuEndpoint: { liveChatItemContextMenuEndpoint: { params: 'MENU' } }
            }
          },
          moderationButtons: [modButton('Show', 'APPROVE'), modButton('Hide', 'KEEPHIDDEN')],
          inlineActionButtons: [
            inlineButton('DELETE', 'Remove', 'REMOVE'),
            inlineButton('HOURGLASS', 'Put user in timeout', 'TIMEOUT'),
            inlineButton('REMOVE_CIRCLE', 'Hide user on this channel', 'BAN')
          ],
          ...overrides
        }
      }
    }
  } as RawAction
}

describe('YouTube membership gifts and mode changes', () => {
  function item(renderer: Record<string, unknown>): RawAction {
    return { addChatItemAction: { item: renderer } } as RawAction
  }

  it('captures a gift purchase as a membership_gift highlight from the nested header', () => {
    const { messages } = normalizeAction(
      'src',
      item({
        liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
          id: 'gift1',
          timestampUsec: '1700000000000000',
          authorExternalChannelId: 'UCgifter',
          header: {
            liveChatSponsorshipsHeaderRenderer: {
              authorName: { simpleText: 'Gifter' },
              primaryText: { runs: [{ text: 'Gifted ' }, { text: '5' }, { text: ' memberships' }] }
            }
          }
        }
      })
    )
    expect(messages[0]?.author.name).toBe('Gifter')
    // The gifter's stable channel id lives on the outer renderer, not the nested header.
    expect(messages[0]?.author.id).toBe('UCgifter')
    expect(messages[0]?.highlight).toEqual({
      kind: 'membership_gift',
      headerText: 'Gifted 5 memberships'
    })
  })

  it('gives id-less gift/mode events distinct fallback ids instead of collapsing them', () => {
    const giftId = (text: string): string | undefined =>
      normalizeAction(
        'src',
        item({
          liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
            header: { liveChatSponsorshipsHeaderRenderer: { primaryText: { runs: [{ text }] } } }
          }
        })
      ).messages[0]?.id
    const modeId = (text: string): string | undefined =>
      normalizeAction(
        'src',
        item({ liveChatModeChangeMessageRenderer: { text: { runs: [{ text }] } } })
      ).messages[0]?.id
    // No id and no timestamp on either event — they must still differ by content (not both `…:0`).
    expect(giftId('Gifted 5 memberships')).not.toBe(giftId('Gifted 10 memberships'))
    expect(modeId('Slow mode is on')).not.toBe(modeId('Slow mode is off'))
  })

  it('captures a gift redemption as a membership highlight carrying the line', () => {
    const { messages } = normalizeAction(
      'src',
      item({
        liveChatSponsorshipsGiftRedemptionAnnouncementRenderer: {
          id: 'redeem1',
          authorName: { simpleText: 'Recipient' },
          message: { runs: [{ text: 'was gifted a membership by Gifter' }] }
        }
      })
    )
    expect(messages[0]?.author.name).toBe('Recipient')
    // The gifter's purchase was announced separately, so the delivery to the recipient must not be
    // counted as a second membership.
    expect(messages[0]?.highlight).toEqual({
      kind: 'membership',
      headerText: 'was gifted a membership by Gifter',
      notAPurchase: true
    })
  })

  it('captures a mode change as a YouTube-authored system line', () => {
    const { messages } = normalizeAction(
      'src',
      item({
        liveChatModeChangeMessageRenderer: {
          id: 'mode1',
          text: { runs: [{ text: 'Slow mode is on' }] },
          subtext: { runs: [{ text: 'Send a message every 30 seconds' }] }
        }
      })
    )
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.author.name).toBe('YouTube')
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'Slow mode is on — Send a message every 30 seconds' }
    ])
  })

  it('no longer flags the gift/mode renderers as unknown parse-health keys', () => {
    expect(
      unknownActionKeys(item({ liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {} }))
    ).toEqual([])
    expect(unknownActionKeys(item({ liveChatModeChangeMessageRenderer: {} }))).toEqual([])
  })
})

describe('YouTube held-for-review messages', () => {
  it('surfaces the wrapped message, the review header, and only the Show/Hide review buttons', () => {
    const { messages } = normalizeAction('src', heldAction())
    expect(messages).toHaveLength(1)
    const message = messages[0]
    // The held container owns the id; the author/text/menu come from the wrapped item.
    expect(message?.id).toBe('held-1')
    expect(message?.menuToken).toBe('MENU')
    expect(message?.author.displayName).toBe('Spammer')
    expect(message?.fragments).toEqual([{ type: 'text', text: 'questionable' }])
    expect(message?.held?.headerText).toBe('This message is held for review.')
    // Only the Show/Hide review toggle is surfaced on the card; the per-author inlineActionButtons
    // (Remove / timeout / hide-user) are dropped — they're on the message's right-click menu.
    expect(message?.held?.actions.map((action) => [action.label, action.id])).toEqual([
      ['Show', 'review-0'],
      ['Hide', 'review-1']
    ])
    expect(message?.held?.actions.every((action) => action.token.length > 0)).toBe(true)
  })

  it('is a recognized action, not a parse-health unknown', () => {
    expect(unknownActionKeys(heldAction())).toEqual([])
  })

  it('still surfaces the held message when YouTube omits the inline buttons', () => {
    const { messages } = normalizeAction(
      'src',
      heldAction({ moderationButtons: undefined, inlineActionButtons: undefined })
    )
    expect(messages[0]?.held?.actions).toEqual([])
    expect(messages[0]?.author.displayName).toBe('Spammer')
  })

  // The Live view / standing backlog delivers a held message as an ordinary text renderer that
  // carries the held header (and its own buttons) rather than the liveChatAutoModMessageRenderer
  // wrapper — the headerText is the marker common to both shapes.
  function plainHeldText(): RawAction {
    return {
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id: 'held-plain',
            timestampUsec: '1700000000000000',
            authorName: { simpleText: 'Spammer' },
            authorExternalChannelId: 'UCspam',
            message: { runs: [{ text: 'questionable' }] },
            headerText: { runs: [{ text: 'This message is held for review.' }] },
            moderationButtons: [modButton('Show', 'APPROVE'), modButton('Hide', 'KEEPHIDDEN')],
            inlineActionButtons: [inlineButton('DELETE', 'Remove', 'REMOVE')]
          }
        }
      }
    } as RawAction
  }

  it('detects a held message that arrives as a plain text renderer with a held header', () => {
    const { messages } = normalizeAction('src', plainHeldText())
    expect(messages).toHaveLength(1)
    expect(messages[0]?.held?.headerText).toBe('This message is held for review.')
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: 'questionable' }])
    // Only the Show/Hide review buttons; the inline Remove is dropped (it's on the right-click menu).
    expect(messages[0]?.held?.actions.map((action) => action.label)).toEqual(['Show', 'Hide'])
  })

  it('marks a held replacement when it arrives as a plain text renderer with a held header', () => {
    const item = (plainHeldText().addChatItemAction as { item: unknown }).item
    const { replacements } = normalizeAction('src', {
      replaceChatItemAction: { targetItemId: 'orig-id', replacementItem: item }
    } as RawAction)
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.id).toBe('orig-id')
    expect(replacements[0]?.held?.headerText).toBe('This message is held for review.')
  })

  it('does not mark an ordinary message (no header) as held', () => {
    const { messages } = normalizeAction('src', textMessage([{ text: 'just a normal message' }]))
    expect(messages[0]?.held).toBeUndefined()
  })
})

describe('YouTube replaceChatItemAction', () => {
  it('approves a held message into a normal message keyed to the held id', () => {
    const action = {
      replaceChatItemAction: {
        targetItemId: 'held-1',
        replacementItem: {
          liveChatTextMessageRenderer: {
            id: 'held-1',
            authorName: { simpleText: 'Spammer' },
            timestampUsec: '1700000000000000',
            message: { runs: [{ text: 'questionable' }] }
          }
        }
      }
    } as RawAction
    const { messages, replacements, clears } = normalizeAction('src', action)
    expect(messages).toEqual([])
    expect(clears).toEqual([])
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.id).toBe('held-1')
    expect(replacements[0]?.held).toBeUndefined()
    expect(replacements[0]?.deleted).toBeUndefined()
  })

  it('hides a held message into a deleted-state replacement', () => {
    const action = {
      replaceChatItemAction: {
        targetItemId: 'held-1',
        replacementItem: {
          liveChatTextMessageRenderer: {
            id: 'held-1',
            authorName: { simpleText: 'Spammer' },
            timestampUsec: '1700000000000000',
            message: { runs: [{ text: 'questionable' }] },
            deletedStateMessage: { runs: [{ text: 'hidden by @mod' }] }
          }
        }
      }
    } as RawAction
    const { replacements } = normalizeAction('src', action)
    expect(replacements[0]?.deleted).toBe(true)
    expect(replacements[0]?.fragments).toEqual([{ type: 'text', text: 'questionable' }])
  })

  it('is a recognized action, not a parse-health unknown', () => {
    const action = {
      replaceChatItemAction: {
        targetItemId: 'x',
        replacementItem: { liveChatTextMessageRenderer: { id: 'x' } }
      }
    } as RawAction
    expect(unknownActionKeys(action)).toEqual([])
  })
})

describe('YouTube moderation-activity notices', () => {
  function item(renderer: Record<string, unknown>): RawAction {
    return { addChatItemAction: { item: renderer } } as RawAction
  }
  // Runs render one text fragment each; join them to compare against YouTube's verbatim wording.
  function noticeText(message: ChatMessage | undefined): string {
    return (message?.fragments ?? []).map((f) => (f.type === 'text' ? f.text : '')).join('')
  }
  // The real captured runs: target, connective, mod, (duration…) — handle-only, styling stripped.
  function modRuns(runs: Array<{ text: string }>): RawAction {
    return item({
      liveChatModerationMessageRenderer: {
        id: 'mod1',
        timestampUsec: '1783254927971769',
        message: { runs }
      }
    })
  }

  it('renders the timeout notice verbatim as a distinct YouTube-authored system line', () => {
    const { messages } = normalizeAction(
      'src',
      modRuns([
        { text: '@viewer' },
        { text: ' was timed out by ' },
        { text: '@moderator' },
        { text: ' for ' },
        { text: '60' },
        { text: ' seconds.' }
      ])
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.moderationNotice).toBe(true)
    expect(messages[0]?.author.name).toBe('YouTube')
    expect(messages[0]?.id).toBe('mod1')
    expect(noticeText(messages[0])).toBe('@viewer was timed out by @moderator for 60 seconds.')
  })

  it('renders hide-user and unhide-user notices verbatim', () => {
    const hide = normalizeAction(
      'src',
      modRuns([
        { text: '@viewer' },
        { text: ' was hidden by ' },
        { text: '@moderator' },
        { text: '.' }
      ])
    ).messages[0]
    const unhide = normalizeAction(
      'src',
      modRuns([
        { text: '@viewer' },
        { text: ' was unhidden by ' },
        { text: '@moderator' },
        { text: '.' }
      ])
    ).messages[0]
    expect(noticeText(hide)).toBe('@viewer was hidden by @moderator.')
    expect(noticeText(unhide)).toBe('@viewer was unhidden by @moderator.')
    expect(unhide?.moderationNotice).toBe(true)
  })

  it('carries any timeout duration verbatim (only 60s was captured, but the text drives it)', () => {
    for (const dur of ['10 seconds', '5 minutes', '1 hour', '24 hours']) {
      const { messages } = normalizeAction(
        'src',
        modRuns([
          { text: '@u' },
          { text: ' was timed out by ' },
          { text: '@m' },
          { text: ` for ${dur}.` }
        ])
      )
      expect(noticeText(messages[0])).toBe(`@u was timed out by @m for ${dur}.`)
    }
  })

  it('synthesizes a hide notice from a single-message hide, alongside the struck row', () => {
    const action = {
      replaceChatItemAction: {
        targetItemId: 'msg-1',
        replacementItem: {
          liveChatTextMessageRenderer: {
            id: 'msg-1',
            timestampUsec: '1783254823087407',
            authorName: { simpleText: '@viewer' },
            message: { runs: [{ text: '69' }] },
            deletedStateMessage: {
              runs: [
                { text: 'Message hidden by ' },
                { text: '@moderator', bold: true },
                { text: '.' }
              ]
            }
          }
        }
      }
    } as RawAction
    const { messages, replacements } = normalizeAction('src', action)
    // The struck row still updates in place…
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.id).toBe('msg-1')
    expect(replacements[0]?.deleted).toBe(true)
    // …and a separate accent notice announces who hid it.
    expect(messages).toHaveLength(1)
    expect(messages[0]?.moderationNotice).toBe(true)
    expect(messages[0]?.id).not.toBe('msg-1') // distinct id so it doesn't clobber the row
    expect(noticeText(messages[0])).toBe('Message hidden by @moderator.')
  })

  it('does not synthesize a notice when a replace approves (no deletedStateMessage)', () => {
    const action = {
      replaceChatItemAction: {
        targetItemId: 'msg-2',
        replacementItem: {
          liveChatTextMessageRenderer: { id: 'msg-2', message: { runs: [{ text: 'ok' }] } }
        }
      }
    } as RawAction
    const { messages, replacements } = normalizeAction('src', action)
    expect(replacements).toHaveLength(1)
    expect(messages).toHaveLength(0)
  })

  it('gives id-less notices distinct ids by content instead of collapsing them', () => {
    const noticeId = (text: string): string | undefined =>
      normalizeAction(
        'src',
        item({ liveChatModerationMessageRenderer: { message: { runs: [{ text }] } } })
      ).messages[0]?.id
    expect(noticeId('@a was hidden by @m.')).not.toBe(noticeId('@b was hidden by @m.'))
  })

  it('skips a notice whose runs carry no text', () => {
    const { messages } = normalizeAction(
      'src',
      item({ liveChatModerationMessageRenderer: { id: 'mod2', message: { runs: [] } } })
    )
    expect(messages).toHaveLength(0)
  })

  it('is now a recognized item, not a parse-health unknown', () => {
    expect(unknownActionKeys(item({ liveChatModerationMessageRenderer: {} }))).toEqual([])
  })
})

describe('parseChannelActivity', () => {
  const heading = (content: string): Record<string, unknown> => ({
    listItemViewModel: { title: { content, styleRuns: [{ weightLabel: 'FONT_WEIGHT_MEDIUM' }] } }
  })
  const factoid = (value: string, label: string): Record<string, unknown> => ({
    factoidRenderer: { value: { simpleText: value }, label: { runs: [{ text: label }] } }
  })
  const historyItem = (
    id: string,
    usec: string,
    text: string,
    state: string
  ): Record<string, unknown> => ({
    liveChatTextMessageRenderer: {
      id,
      timestampUsec: usec,
      authorName: { simpleText: '@viewer' },
      message: { runs: [{ text }] },
      deletedStateMessage: { runs: [{ text: state, italics: true }] }
    }
  })
  function panel(contents: Array<Record<string, unknown>>): unknown {
    return {
      content: {
        engagementPanelSectionListRenderer: { content: { sectionListRenderer: { contents } } }
      }
    }
  }

  // A get_panel "channel activity" response: identity, moderated-activity counts, then message history.
  const response = panel([
    { liveChatProfileIdentityViewModel: { channelName: { content: '@viewer' } } },
    heading('Moderated activities in the last year'),
    {
      liveChatChannelActivityReputationRenderer: {
        factoids: [factoid('0', 'Deleted messages'), factoid('1', 'Timeout'), factoid('1', 'Hide')]
      }
    },
    heading('Chat messages in the last year'),
    { listItemViewModel: { title: { content: 'Schedule test 2 schedule harder' } } },
    {
      liveChatItemDisplayListRenderer: {
        items: [
          historyItem('h1', '1783254823087407', '69', 'Message hidden.'),
          historyItem('h2', '1783253810514383', '69 69', 'This message is held for review.')
        ]
      }
    }
  ])

  it('parses counts, headings, and history in delivery order (plain then moderated)', () => {
    const activity = parseChannelActivity('src', 'UCtarget', response)
    expect(activity?.counts).toEqual([
      { label: 'Deleted messages', value: '0' },
      { label: 'Timeout', value: '1' },
      { label: 'Hide', value: '1' }
    ])
    expect(activity?.countsTitle).toBe('Moderated activities in the last year')
    expect(activity?.historyTitle).toBe('Chat messages in the last year')
    // The plain message precedes the moderated block in the capture; order is preserved.
    expect(activity?.history).toHaveLength(3)
    expect(activity?.history[0]).toEqual({ kind: 'plain', text: 'Schedule test 2 schedule harder' })
    const first = activity?.history[1]
    const second = activity?.history[2]
    expect(first?.kind).toBe('message')
    expect(second?.kind).toBe('message')
    if (first?.kind === 'message' && second?.kind === 'message') {
      expect(first.message.id).toBe('h1') // newest first, as delivered
      expect(second.message.id).toBe('h2')
      expect(first.message.deleted).toBe(true)
      // The panel is scoped to the target, so every row's author id is pinned to it (MMR-007)…
      expect(first.message.author.id).toBe('UCtarget')
      // …and moderators see the original text even on a hidden message.
      expect(first.message.fragments).toEqual([{ type: 'text', text: '69' }])
    }
  })

  it('keeps factoid labels verbatim (they pluralize/localize: Timeouts/Hides)', () => {
    const activity = parseChannelActivity(
      'src',
      'UCtarget',
      panel([
        heading('Moderated activities in the last year'),
        {
          liveChatChannelActivityReputationRenderer: {
            factoids: [factoid('2', 'Timeouts'), factoid('2', 'Hides')]
          }
        }
      ])
    )
    expect(activity?.counts).toEqual([
      { label: 'Timeouts', value: '2' },
      { label: 'Hides', value: '2' }
    ])
  })

  it('returns undefined on shape drift or an empty panel', () => {
    expect(parseChannelActivity('src', 'UCtarget', {})).toBeUndefined()
    expect(parseChannelActivity('src', 'UCtarget', undefined)).toBeUndefined()
    expect(parseChannelActivity('src', 'UCtarget', panel([]))).toBeUndefined()
  })
})
