import { describe, expect, test } from 'bun:test'

import { captureQuoteCandidate, decideQuoteAnchor, prependQuoteAnchor, renderQuoteAnchor } from './router'
import {
  DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS,
  QUOTED_REPLY_EXCERPT_MAX_CHARS,
  type ChannelAdapterConfig,
} from './schema'

const baseConfig: ChannelAdapterConfig = {
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
}

const humanInbound = {
  text: 'hey there',
  authorName: 'Alice',
  authorIsBot: false,
  receivedAt: 1000,
}

describe('renderQuoteAnchor', () => {
  test('formats single-line user text verbatim', () => {
    expect(renderQuoteAnchor({ authorName: 'Alice', text: 'hello' })).toBe('> @Alice: hello')
  })

  test('collapses newlines so the quote stays on one line', () => {
    expect(renderQuoteAnchor({ authorName: 'Bob', text: 'line one\nline two\n\nline three' })).toBe(
      '> @Bob: line one line two line three',
    )
  })

  test('truncates excerpts longer than the cap with an ellipsis', () => {
    const long = 'a'.repeat(QUOTED_REPLY_EXCERPT_MAX_CHARS + 50)
    const out = renderQuoteAnchor({ authorName: 'Carol', text: long })
    expect(out.length).toBe('> @Carol: '.length + QUOTED_REPLY_EXCERPT_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  test('falls back to a no-text marker for bare-mention inbounds', () => {
    expect(renderQuoteAnchor({ authorName: 'Dave', text: '   ' })).toBe('> @Dave: (no text)')
    expect(renderQuoteAnchor({ authorName: 'Dave', text: '' })).toBe('> @Dave: (no text)')
  })

  test('strips a leading > so a quote-of-a-quote stays single-level', () => {
    expect(renderQuoteAnchor({ authorName: 'Eve', text: '> their reply\nfollowup' })).toBe(
      '> @Eve: their reply followup',
    )
  })
})

describe('prependQuoteAnchor', () => {
  test('separates the anchor and reply with a single newline', () => {
    expect(prependQuoteAnchor('I see you', { authorName: 'Alice', text: 'yo' })).toBe('> @Alice: yo\nI see you')
  })

  test('returns just the anchor when the reply text is empty (attachment-only)', () => {
    expect(prependQuoteAnchor('', { authorName: 'Alice', text: 'yo' })).toBe('> @Alice: yo')
  })
})

describe('captureQuoteCandidate', () => {
  test('returns null when the batch is empty', () => {
    expect(captureQuoteCandidate([], [])).toBeNull()
  })

  test('returns null when the primary inbound is a bot', () => {
    expect(captureQuoteCandidate([{ ...humanInbound, authorIsBot: true }], [])).toBeNull()
  })

  test('captures the LAST batch entry as primary (matches drain semantics)', () => {
    const earlier = { ...humanInbound, authorName: 'Earlier', text: 'first', receivedAt: 1000 }
    const later = { ...humanInbound, authorName: 'Later', text: 'second', receivedAt: 2000 }
    const result = captureQuoteCandidate([earlier, later], [])
    expect(result?.source).toEqual({ authorName: 'Later', text: 'second' })
    expect(result?.primaryReceivedAt).toBe(2000)
  })

  test('flags hadInterveningObserved when any observed entry landed at-or-after the primary', () => {
    const result = captureQuoteCandidate([humanInbound], [{ receivedAt: humanInbound.receivedAt + 100 }])
    expect(result?.hadInterveningObserved).toBe(true)
  })

  test('clears hadInterveningObserved when all observed entries predate the primary', () => {
    const result = captureQuoteCandidate([humanInbound], [{ receivedAt: humanInbound.receivedAt - 100 }])
    expect(result?.hadInterveningObserved).toBe(false)
  })
})

describe('decideQuoteAnchor', () => {
  test('null candidate always returns null', () => {
    expect(decideQuoteAnchor(null, 999_999, baseConfig)).toBeNull()
  })

  test('returns null when send-time delay is below threshold and no intervening observed', () => {
    const candidate = captureQuoteCandidate([humanInbound], [])!
    expect(decideQuoteAnchor(candidate, humanInbound.receivedAt + 1_000, baseConfig)).toBeNull()
  })

  test('returns the anchor when send-time delay crosses the default threshold', () => {
    const candidate = captureQuoteCandidate([humanInbound], [])!
    const out = decideQuoteAnchor(
      candidate,
      humanInbound.receivedAt + DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS + 1,
      baseConfig,
    )
    expect(out).toEqual({ authorName: 'Alice', text: 'hey there' })
  })

  test('returns the anchor when an observed message landed after the primary, even within threshold', () => {
    const candidate = captureQuoteCandidate([humanInbound], [{ receivedAt: humanInbound.receivedAt + 500 }])!
    const out = decideQuoteAnchor(candidate, humanInbound.receivedAt + 1_000, baseConfig)
    expect(out).toEqual({ authorName: 'Alice', text: 'hey there' })
  })

  test('respects an explicit enabled: false override', () => {
    const candidate = captureQuoteCandidate([humanInbound], [])!
    const disabled: ChannelAdapterConfig = { ...baseConfig, quotedReply: { enabled: false, queueDelayMs: 0 } }
    const out = decideQuoteAnchor(candidate, humanInbound.receivedAt + 999_999, disabled)
    expect(out).toBeNull()
  })

  test('respects a custom queueDelayMs', () => {
    const candidate = captureQuoteCandidate([humanInbound], [])!
    const aggressive: ChannelAdapterConfig = { ...baseConfig, quotedReply: { enabled: true, queueDelayMs: 0 } }
    expect(decideQuoteAnchor(candidate, humanInbound.receivedAt, aggressive)).toEqual({
      authorName: 'Alice',
      text: 'hey there',
    })
  })

  test('falls back to the default threshold when the adapter has no quotedReply config', () => {
    const candidate = captureQuoteCandidate([humanInbound], [])!
    expect(
      decideQuoteAnchor(candidate, humanInbound.receivedAt + DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS + 1, baseConfig),
    ).toEqual({ authorName: 'Alice', text: 'hey there' })
  })
})
