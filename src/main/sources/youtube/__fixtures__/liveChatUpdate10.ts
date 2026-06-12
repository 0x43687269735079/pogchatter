/**
 * Sanitized real InnerTube `live_chat/get_live_chat` response body, captured from a logged-out
 * browser session (capture `10-live-chat-update-response`, 2026-06-01): one text message with
 * a standard unicode emoji, plus an advancing invalidation-mode continuation.
 *
 * Trimmed to the subtrees the reader/normalizer consume (`responseContext`, `frameworkUpdates`,
 * tracking params, client ids and accessibility data are dropped). Opaque continuation/menu tokens
 * are replaced with placeholders — they're protobufs that may embed session state, and only their
 * presence matters to the parser. The video id (`EWrX250Zhko`), message id, author handle/channel
 * id and chat text are public chat data and kept verbatim.
 */
export const liveChatUpdate10 = {
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
              protoCreationTimestampMs: '1780318288918'
            },
            timeoutMs: 10000,
            continuation: 'continuation-10-next'
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
                    { text: 'UK Aani ' },
                    {
                      // A standard unicode emoji still carries a noto image (and no width on its
                      // thumbnail) — it must render as text, not as an emote image.
                      emoji: {
                        emojiId: '🇬🇧',
                        image: {
                          thumbnails: [
                            {
                              url: 'https://fonts.gstatic.com/s/e/notoemoji/15.1/1f1ec_1f1e7/72.png'
                            }
                          ]
                        }
                      }
                    },
                    { text: ' ' }
                  ]
                },
                authorName: { simpleText: '@Suzanne_-_z8l' },
                authorPhoto: {
                  thumbnails: [
                    {
                      url: 'https://yt4.ggpht.com/LzMuVDfHAfb0uytyrzLA45MOQE3-0x-KffBoOsVgy0A41Y4vuxv29BFu-nkRmoPP3dXMwHgyyA=s32-c-k-c0x00ffffff-no-rj',
                      width: 32,
                      height: 32
                    },
                    {
                      url: 'https://yt4.ggpht.com/LzMuVDfHAfb0uytyrzLA45MOQE3-0x-KffBoOsVgy0A41Y4vuxv29BFu-nkRmoPP3dXMwHgyyA=s64-c-k-c0x00ffffff-no-rj',
                      width: 64,
                      height: 64
                    }
                  ]
                },
                contextMenuEndpoint: {
                  commandMetadata: { webCommandMetadata: { ignoreNavigation: true } },
                  liveChatItemContextMenuEndpoint: { params: 'menu-params-10' }
                },
                id: 'ChwKGkNOV3A1N2lLNXBRREZjRldxd0lkZVM0ZUVB',
                timestampUsec: '1780318287291168',
                authorExternalChannelId: 'UC67EV81fvGR6NIV7jxV17pQ'
              }
            }
          }
        }
      ]
    }
  }
}
