/**
 * Sanitized real `/live_chat` iframe bootstrap (capture `2-response`, 2026-06-01): the
 * `ytInitialData.continuationContents.liveChatContinuation` a chat opens with, trimmed to the
 * subtrees the reader/normalizer consume. It pins three real shapes from one capture:
 *
 * - the **Top chat / Live chat view selector** (Top chat is item 0 and selected by default;
 *   Live chat is item 1, reachable via its reload continuation),
 * - **`removeChatItemAction`** (YouTube dropping a single message outright), and
 * - **`addBannerToLiveChatCommand`** (a pinned-banner action the normalizer doesn't consume —
 *   kept as a real example of an action type that must be skipped and counted, never thrown on).
 *
 * Sanitization: tracking params replaced with placeholders, opaque continuation tokens replaced
 * with placeholders, all non-consumed renderer bodies trimmed. Message ids, author handles/channel
 * ids and chat text are public chat data and kept verbatim.
 */
export const liveChatBootstrap2 = {
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
              protoCreationTimestampMs: '1780277026544'
            },
            timeoutMs: 10000,
            continuation: 'continuation-2-top-next'
          }
        }
      ],
      actions: [
        {
          clickTrackingParams: 'click-tracking-2',
          // Real unknown-to-us action type (banner contents trimmed; the normalizer skips it whole).
          addBannerToLiveChatCommand: { bannerRenderer: {} }
        },
        {
          clickTrackingParams: 'click-tracking-2',
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                message: { runs: [{ text: "I don't remember that" }] },
                authorName: { simpleText: '@twwaq' },
                id: 'ChwKGkNNbVZzN2p2NUpRREZXNVBxd0lkV1JNbzlB',
                timestampUsec: '1780276678943725',
                authorExternalChannelId: 'UCgm9Nfocs9_tcPYeJ7xdqTA'
              }
            }
          }
        },
        {
          clickTrackingParams: 'click-tracking-2',
          removeChatItemAction: { targetItemId: 'ChwKGkNJM3h3cWJ2NUpRREZmSGVQd1FkcVZBSjVB' }
        },
        {
          clickTrackingParams: 'click-tracking-2',
          removeChatItemAction: { targetItemId: 'ChwKGkNKcWY5S0R2NUpRREZXcnRQd1FkNTlBQS1n' }
        }
      ],
      header: {
        liveChatHeaderRenderer: {
          viewSelector: {
            sortFilterSubMenuRenderer: {
              subMenuItems: [
                {
                  title: 'Top chat',
                  selected: true,
                  continuation: {
                    reloadContinuationData: { continuation: 'continuation-2-top-reload' }
                  },
                  subtitle: 'Some messages, such as potential spam, may not be visible'
                },
                {
                  title: 'Live chat',
                  selected: false,
                  continuation: {
                    reloadContinuationData: { continuation: 'continuation-2-live-reload' }
                  },
                  subtitle: 'All messages are visible'
                }
              ]
            }
          }
        }
      }
    }
  }
}
