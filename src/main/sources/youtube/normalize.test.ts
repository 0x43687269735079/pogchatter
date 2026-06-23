import { describe, expect, it } from 'vitest'
import {
  normalizeAction,
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
    expect(message?.highlight).toEqual({ kind: 'membership', headerText: 'Member for 6 months' })
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
    expect(messages[0]?.highlight).toEqual({
      kind: 'membership_gift',
      headerText: 'Gifted 5 memberships'
    })
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
    expect(messages[0]?.highlight).toEqual({
      kind: 'membership',
      headerText: 'was gifted a membership by Gifter'
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
