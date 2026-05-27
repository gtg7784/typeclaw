import { describe, expect, test } from 'bun:test'

import { captureQuoteCandidate, decideQuoteAnchor, prependQuoteAnchor, renderQuoteAnchor } from './router'
import { QUOTED_REPLY_EXCERPT_MAX_CHARS, type ChannelAdapterConfig } from './schema'

const baseConfig: ChannelAdapterConfig = {
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
}

const humanInbound = {
  text: 'hey there',
  authorId: 'U_ALICE',
  authorName: 'Alice',
  authorIsBot: false,
  receivedAt: 1000,
}

describe('renderQuoteAnchor', () => {
  test('Slack: emits a real `<@authorId>` mention so the quote anchors against the platform-native mention', () => {
    expect(renderQuoteAnchor({ adapter: 'slack-bot', authorId: 'U_ALICE', authorName: 'Alice', text: 'hello' })).toBe(
      '> <@U_ALICE>: hello',
    )
  })

  test('Discord: emits a real `<@authorId>` mention', () => {
    expect(
      renderQuoteAnchor({ adapter: 'discord-bot', authorId: '123456789', authorName: 'Alice', text: 'hello' }),
    ).toBe('> <@123456789>: hello')
  })

  test('Telegram: falls back to plain authorName (no reliable id-only mention syntax in markdown)', () => {
    expect(renderQuoteAnchor({ adapter: 'telegram-bot', authorId: '42', authorName: 'Alice', text: 'hello' })).toBe(
      '> Alice: hello',
    )
  })

  test('KakaoTalk: falls back to plain authorName (platform has no mention syntax)', () => {
    expect(renderQuoteAnchor({ adapter: 'kakaotalk', authorId: 'u-1', authorName: 'Alice', text: 'hello' })).toBe(
      '> Alice: hello',
    )
  })

  test('GitHub: falls back to plain authorName (inbound authorId is a numeric user id, not the handle)', () => {
    expect(renderQuoteAnchor({ adapter: 'github', authorId: '12345', authorName: 'alice', text: 'hello' })).toBe(
      '> alice: hello',
    )
  })

  test('does NOT emit a literal `> @name:` form on any adapter (PR #374 regression)', () => {
    for (const adapter of ['slack-bot', 'discord-bot', 'telegram-bot', 'kakaotalk', 'github'] as const) {
      const out = renderQuoteAnchor({ adapter, authorId: 'U1', authorName: 'Alice', text: 'hi' })
      expect(out.startsWith('> @')).toBe(false)
    }
  })

  test('collapses newlines so the quote stays on one line', () => {
    expect(
      renderQuoteAnchor({
        adapter: 'slack-bot',
        authorId: 'U1',
        authorName: 'Bob',
        text: 'line one\nline two\n\nline three',
      }),
    ).toBe('> <@U1>: line one line two line three')
  })

  test('truncates excerpts longer than the cap with an ellipsis', () => {
    const long = 'a'.repeat(QUOTED_REPLY_EXCERPT_MAX_CHARS + 50)
    const out = renderQuoteAnchor({ adapter: 'kakaotalk', authorId: 'u-1', authorName: 'Carol', text: long })
    expect(out.length).toBe('> Carol: '.length + QUOTED_REPLY_EXCERPT_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  test('falls back to a no-text marker for bare-mention inbounds', () => {
    expect(renderQuoteAnchor({ adapter: 'slack-bot', authorId: 'U1', authorName: 'Dave', text: '   ' })).toBe(
      '> <@U1>: (no text)',
    )
    expect(renderQuoteAnchor({ adapter: 'slack-bot', authorId: 'U1', authorName: 'Dave', text: '' })).toBe(
      '> <@U1>: (no text)',
    )
  })

  test('strips a leading > so a quote-of-a-quote stays single-level', () => {
    expect(
      renderQuoteAnchor({
        adapter: 'discord-bot',
        authorId: '987',
        authorName: 'Eve',
        text: '> their reply\nfollowup',
      }),
    ).toBe('> <@987>: their reply followup')
  })
})

describe('prependQuoteAnchor', () => {
  test('separates the anchor and reply with a blank line so the blockquote does not swallow the reply', () => {
    expect(
      prependQuoteAnchor('I see you', { adapter: 'slack-bot', authorId: 'U_ALICE', authorName: 'Alice', text: 'yo' }),
    ).toBe('> <@U_ALICE>: yo\n\nI see you')
  })

  test('returns just the anchor when the reply text is empty (attachment-only)', () => {
    expect(prependQuoteAnchor('', { adapter: 'slack-bot', authorId: 'U_ALICE', authorName: 'Alice', text: 'yo' })).toBe(
      '> <@U_ALICE>: yo',
    )
  })
})

describe('captureQuoteCandidate', () => {
  test('returns null when the batch is empty', () => {
    expect(captureQuoteCandidate('slack-bot', [], [])).toBeNull()
  })

  test('returns null when the primary inbound is a bot', () => {
    expect(captureQuoteCandidate('slack-bot', [{ ...humanInbound, authorIsBot: true }], [])).toBeNull()
  })

  test('captures the LAST batch entry as primary and stamps the adapter onto source', () => {
    const earlier = { ...humanInbound, authorId: 'U_EARLY', authorName: 'Earlier', text: 'first', receivedAt: 1000 }
    const later = { ...humanInbound, authorId: 'U_LATE', authorName: 'Later', text: 'second', receivedAt: 2000 }
    const result = captureQuoteCandidate('slack-bot', [earlier, later], [])
    expect(result?.source).toEqual({ adapter: 'slack-bot', authorId: 'U_LATE', authorName: 'Later', text: 'second' })
    expect(result?.primaryReceivedAt).toBe(2000)
  })

  test('flags hadInterveningObserved when a live-observed entry landed at-or-after the primary', () => {
    const result = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [{ receivedAt: humanInbound.receivedAt + 100, source: 'observed' }],
    )
    expect(result?.hadInterveningObserved).toBe(true)
  })

  test('clears hadInterveningObserved when all live-observed entries predate the primary', () => {
    const result = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [{ receivedAt: humanInbound.receivedAt - 100, source: 'observed' }],
    )
    expect(result?.hadInterveningObserved).toBe(false)
  })

  test('ignores prefetched scrollback when computing hadInterveningObserved (cold-start regression)', () => {
    const result = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [
        { receivedAt: humanInbound.receivedAt + 100, source: 'prefetch' },
        { receivedAt: humanInbound.receivedAt + 200, source: 'prefetch' },
        { receivedAt: humanInbound.receivedAt + 300, source: 'prefetch' },
      ],
    )
    expect(result?.hadInterveningObserved).toBe(false)
  })

  test('mixed prefetch+observed: only the live-observed entries count', () => {
    const result = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [
        { receivedAt: humanInbound.receivedAt + 100, source: 'prefetch' },
        { receivedAt: humanInbound.receivedAt + 200, source: 'observed' },
      ],
    )
    expect(result?.hadInterveningObserved).toBe(true)
  })
})

describe('decideQuoteAnchor', () => {
  test('null candidate always returns null', () => {
    expect(decideQuoteAnchor(null, 999_999, baseConfig)).toBeNull()
  })

  test('returns null when no observed message intervened, even after a long delay', () => {
    const candidate = captureQuoteCandidate('slack-bot', [humanInbound], [])!
    expect(decideQuoteAnchor(candidate, humanInbound.receivedAt + 600_000, baseConfig)).toBeNull()
  })

  test('returns the anchor when an observed message landed after the primary, even within threshold', () => {
    const candidate = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [{ receivedAt: humanInbound.receivedAt + 500, source: 'observed' }],
    )!
    const out = decideQuoteAnchor(candidate, humanInbound.receivedAt + 1_000, baseConfig)
    expect(out).toEqual({ adapter: 'slack-bot', authorId: 'U_ALICE', authorName: 'Alice', text: 'hey there' })
  })

  test('respects an explicit enabled: false override', () => {
    const candidate = captureQuoteCandidate('slack-bot', [humanInbound], [])!
    const disabled: ChannelAdapterConfig = { ...baseConfig, quotedReply: { enabled: false, queueDelayMs: 0 } }
    const out = decideQuoteAnchor(candidate, humanInbound.receivedAt + 999_999, disabled)
    expect(out).toBeNull()
  })

  test('does not let custom queueDelayMs force a quote when no message intervened', () => {
    const candidate = captureQuoteCandidate('slack-bot', [humanInbound], [])!
    const aggressive: ChannelAdapterConfig = { ...baseConfig, quotedReply: { enabled: true, queueDelayMs: 0 } }
    expect(decideQuoteAnchor(candidate, humanInbound.receivedAt + 600_000, aggressive)).toBeNull()
  })

  test('quotes with no quotedReply config when an observed message intervened', () => {
    const candidate = captureQuoteCandidate(
      'slack-bot',
      [humanInbound],
      [{ receivedAt: humanInbound.receivedAt + 500, source: 'observed' }],
    )!
    expect(decideQuoteAnchor(candidate, humanInbound.receivedAt + 1_000, baseConfig)).toEqual({
      adapter: 'slack-bot',
      authorId: 'U_ALICE',
      authorName: 'Alice',
      text: 'hey there',
    })
  })
})
