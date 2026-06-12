/**
 * Sanitized real InnerTube `live_chat/get_live_chat` response body, captured from a logged-out
 * browser session (capture `12-second-live-chat-update-response`, 2026-06-01): two text
 * messages — one ending in a channel's custom member emoji, one plain — plus an advancing
 * invalidation-mode continuation.
 *
 * Sanitized the same way as {@link liveChatUpdate10}: trimmed to the consumed subtrees, opaque
 * continuation/menu tokens replaced with placeholders, public chat data kept verbatim.
 */
export const liveChatUpdate12 = {
  continuationContents: {
    liveChatContinuation: {
      continuations: [
        {
          invalidationContinuationData: {
            invalidationId: {
              objectSource: 1056,
              objectId: 'Y2hhdH5FV3JYMjUwWmhrbw==',
              topic: 'chat~EWrX250Zhko',
              subscribeToGcmTopics: true,
              protoCreationTimestampMs: '1780318292911'
            },
            timeoutMs: 10000,
            continuation: 'continuation-12-next'
          }
        }
      ],
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                message: {
                  runs: [
                    { text: 'tumne doe rkha h fir v slow ho' },
                    {
                      // A channel's proprietary emoji: slash-form emojiId + isCustomEmoji — must
                      // render as an emote image (largest thumbnail), keyed by its shortcut.
                      emoji: {
                        emojiId: 'UCkszU2WH9gy1mb0dV-11UJg/7cIfY5niDOmSkNAP08CA6A4',
                        shortcuts: [':eyes-purple-crying:'],
                        searchTerms: ['eyes-purple-crying'],
                        image: {
                          thumbnails: [
                            {
                              url: 'https://yt3.ggpht.com/FrYgdeZPpvXs-6Mp305ZiimWJ0wV5bcVZctaUy80mnIdwe-P8HRGYAm0OyBtVx8EB9_Dxkc=w24-h24-c-k-nd',
                              width: 24,
                              height: 24
                            },
                            {
                              url: 'https://yt3.ggpht.com/FrYgdeZPpvXs-6Mp305ZiimWJ0wV5bcVZctaUy80mnIdwe-P8HRGYAm0OyBtVx8EB9_Dxkc=w48-h48-c-k-nd',
                              width: 48,
                              height: 48
                            }
                          ]
                        },
                        isCustomEmoji: true
                      }
                    }
                  ]
                },
                authorName: { simpleText: '@ren-x9e' },
                authorPhoto: {
                  thumbnails: [
                    {
                      url: 'https://yt4.ggpht.com/aDyPCYUWu72I9ZExvbWVzCwEDiugQbUdCxjgZy8P7Gme2EC_hVhgt_WKnvvPQZFdOR2_J-Q0=s32-c-k-c0x00ffffff-no-rj',
                      width: 32,
                      height: 32
                    },
                    {
                      url: 'https://yt4.ggpht.com/aDyPCYUWu72I9ZExvbWVzCwEDiugQbUdCxjgZy8P7Gme2EC_hVhgt_WKnvvPQZFdOR2_J-Q0=s64-c-k-c0x00ffffff-no-rj',
                      width: 64,
                      height: 64
                    }
                  ]
                },
                contextMenuEndpoint: {
                  commandMetadata: { webCommandMetadata: { ignoreNavigation: true } },
                  liveChatItemContextMenuEndpoint: { params: 'menu-params-12a' }
                },
                id: 'ChwKGkNLYVN3Ym1LNXBRREZmN2k1d01keVdZcDF3',
                timestampUsec: '1780318288762062',
                authorExternalChannelId: 'UCqOMObrAq8xLnh6R9XlX22g'
              }
            }
          }
        },
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                message: { runs: [{ text: 'gud wbu' }] },
                authorName: { simpleText: '@lily13366' },
                authorPhoto: {
                  thumbnails: [
                    {
                      url: 'https://yt4.ggpht.com/Sn0Kd_QVKt4u9_Fp61PqVzzu4ve7O-JkYE0_RJdBhf2JxMkAmnLQuhIa3IeboVmOiClJyoTfIg=s32-c-k-c0x00ffffff-no-rj',
                      width: 32,
                      height: 32
                    },
                    {
                      url: 'https://yt4.ggpht.com/Sn0Kd_QVKt4u9_Fp61PqVzzu4ve7O-JkYE0_RJdBhf2JxMkAmnLQuhIa3IeboVmOiClJyoTfIg=s64-c-k-c0x00ffffff-no-rj',
                      width: 64,
                      height: 64
                    }
                  ]
                },
                contextMenuEndpoint: {
                  commandMetadata: { webCommandMetadata: { ignoreNavigation: true } },
                  liveChatItemContextMenuEndpoint: { params: 'menu-params-12b' }
                },
                id: 'ChwKGkNOYXN4cnFLNXBRREZRdmV3Z1FkY2tRdE13',
                timestampUsec: '1780318290944921',
                authorExternalChannelId: 'UC3fDAZdoagTE_aqlAWhQY-w'
              }
            }
          }
        }
      ]
    }
  }
}
