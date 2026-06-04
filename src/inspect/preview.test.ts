import { describe, expect, test } from 'bun:test'

import { previewForHint } from './preview'

const TIME = '<current-time>2026-06-04T22:36:14+09:00 (Asia/Seoul, Thursday)</current-time>'

describe('previewForHint', () => {
  test('subagent origin → null (machine payload, label already names it)', () => {
    expect(
      previewForHint({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'p' }, 'Parent session: p'),
    ).toBeNull()
  })

  describe('tui / structural fallback', () => {
    test('strips the leading <current-time> anchor', () => {
      expect(previewForHint({ kind: 'tui' }, `${TIME}\n\nfix the parser`)).toBe('fix the parser')
    })

    test('skips a SYSTEM MESSAGE fence then takes the real line', () => {
      const text = `${TIME}\n\n---\n**[SYSTEM MESSAGE — not from a human]**\n\nIncomplete todo items remain.\n---\n\nthe actual ask`
      expect(previewForHint({ kind: 'tui' }, text)).toBe('the actual ask')
    })

    test('a turn that is only injected blocks → null', () => {
      const text = `${TIME}\n\n---\n**[SYSTEM MESSAGE — not from a human]**\n\nrestarted.\n---`
      expect(previewForHint({ kind: 'tui' }, text)).toBeNull()
    })

    test('skips a future <some-new-tag> block without code changes', () => {
      const text = `<some-new-tag>whatever the runtime adds next</some-new-tag>\n\nreal message`
      expect(previewForHint({ kind: 'tui' }, text)).toBe('real message')
    })

    test('a plain user message with no preamble passes through', () => {
      expect(previewForHint({ kind: 'tui' }, 'just a normal prompt')).toBe('just a normal prompt')
    })
  })

  describe('channel', () => {
    const channelOrigin = { kind: 'channel' as const, adapter: 'slack-bot', workspace: 'w', chat: 'c', thread: null }

    test('extracts the addressed message, ignoring recent context', () => {
      const text = [
        TIME,
        '',
        '## Recent context (not addressed to you, for awareness only)',
        '[2026-06-04T22:00:00Z] <@U1> (alice): someone else chatting',
        '',
        '## Current message (addressed to you)',
        '[2026-06-04T22:36:00Z] <@U2> (bob): is staging still down?',
      ].join('\n')
      expect(previewForHint(channelOrigin, text)).toBe('is staging still down?')
    })

    test('joins a multi-line addressed message', () => {
      const text = [
        '## Current message (addressed to you)',
        '[2026-06-04T22:36:00Z] <@U2> (bob): first line',
        'second line',
      ].join('\n')
      expect(previewForHint(channelOrigin, text)).toBe('first line second line')
    })

    test('handles the plural "Current messages" header', () => {
      const text = ['## Current messages (addressed to you)', '[2026-06-04T22:36:00Z] <@U2> (bob): batched ask'].join(
        '\n',
      )
      expect(previewForHint(channelOrigin, text)).toBe('batched ask')
    })

    test('no addressed message (system-notice-only turn) → null', () => {
      const text = `${TIME}\n\n---\n**[SYSTEM MESSAGE — not from a human]**\n\nloop guard.\n---`
      expect(previewForHint(channelOrigin, text)).toBeNull()
    })

    test('tolerates a missing stamp / bot tag', () => {
      const text = ['## Current message (addressed to you)', '<@U2> (bot-name) [bot]: ping'].join('\n')
      expect(previewForHint(channelOrigin, text)).toBe('ping')
    })
  })
})
