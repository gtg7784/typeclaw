import { describe, expect, test } from 'bun:test'

import { checkOutboundFlood } from './outbound-flood-filter'

describe('checkOutboundFlood — short outbound messages pass', () => {
  test('empty text passes', () => {
    expect(checkOutboundFlood('')).toEqual({ ok: true })
  })

  test('short laughter passes', () => {
    expect(checkOutboundFlood('ㅋㅋㅋ')).toEqual({ ok: true })
  })

  test('short emphatic punctuation passes', () => {
    expect(checkOutboundFlood('!!!!!!!!!!')).toEqual({ ok: true })
  })
})

describe('checkOutboundFlood — outbound flood patterns are blocked', () => {
  test('blocks the production-shaped 500x Korean laughter flood', () => {
    const result = checkOutboundFlood('ㅋ'.repeat(500))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('blocks a long single-character flood', () => {
    const result = checkOutboundFlood('a'.repeat(500))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toBe('repeated-char-run:500')
  })

  test('blocks repeated single-emoji floods', () => {
    const result = checkOutboundFlood('🙂'.repeat(200))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toMatch(/^repeated-char-run:/)
  })

  test('blocks alternating low-diversity text', () => {
    const result = checkOutboundFlood('ab'.repeat(300))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toBe('repeated-pattern-span:2:600')
  })

  test('blocks repeated short-pattern floods', () => {
    const result = checkOutboundFlood('lol'.repeat(300))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toBe('repeated-pattern-span:3:900')
  })

  test('blocks a periodic flood body buried behind a prose prefix', () => {
    // PR #682 review: a whole-message periodicity test misses a flood with a
    // varied lead-in. The contiguous-span detector must still catch the body.
    const result = checkOutboundFlood(`Here is a normal prose lead-in before the flood: ${'lol'.repeat(300)}`)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected outbound flood')
    expect(result.reason).toBe('repeated-pattern-span:3:900')
  })

  test('blocks hundreds of byte-identical rows (accepted denial, not real tables)', () => {
    // Intentional: exact-identical rows past the span floor are information-poor
    // flood-shaped output. Real tables/diagrams vary per row and pass (below).
    expect(checkOutboundFlood('| col | col | col |\n'.repeat(60)).ok).toBe(false)
    expect(checkOutboundFlood('+----+----+----+\n'.repeat(40)).ok).toBe(false)
  })
})

describe('checkOutboundFlood — benign outbound messages pass', () => {
  test('long prose passes', () => {
    const text =
      'I checked the deployment logs and the service is healthy now. The earlier failure came from a transient queue timeout, so I will keep watching for another cycle.'
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })

  test('long mixed-language reply with scattered laughter passes', () => {
    // Mixed Latin + Korean (ㅋㅋㅋ is Korean text-laughter) — the flood filter
    // must not trip on scattered laughter inside otherwise-substantive prose.
    const text =
      'Confirmed ㅋㅋㅋ the deploy is healthy now, next step은 to check the logs one more time. I will share right away if anything looks off ㅋㅋㅋ'
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })

  test('a multi-KB markdown report passes (regression for the dropped reply)', () => {
    // The exact failure shape: a ~3KB markdown decision report. Under the old
    // uniqueRatio gate its distinctChars/length ratio (~0.027) fell below 0.05
    // and it was silently dropped. It must now be delivered.
    const report = [
      '## Goal',
      'Find the best alternatives to Kimi K2.6 (Fireworks) using the leaderboard,',
      'optimized for speed, intelligence, and agentic ability.',
      '',
      '## Bottom line',
      '1. DeepSeek V4 Pro (Max) — best if you want to stay on Fireworks',
      '2. Gemini 3.1 Pro Preview — best balanced alternative',
      '3. Claude Opus 4.8 — best for premium agentic reliability',
      '4. Qwen3.7 Max — strong agentic option, especially for tool-heavy work',
      '5. MiniMax-M3 — good value option but less compelling overall',
      '',
      '---',
      '',
      '### Stay on Fireworks',
      'DeepSeek V4 Pro (Max) — easiest migration path from Kimi K2.6.',
      'Why it stands out: good quality, strong enough for agentic tasks.',
      'Tradeoff: not the absolute best raw capability versus premium models.',
      '',
      '### Best balanced overall',
      'Gemini 3.1 Pro Preview — strong mix of quality and throughput.',
      'Tradeoff: provider switch may matter depending on your stack.',
      '',
      '### Best premium agentic option',
      'Claude Opus 4.8 — best overall intelligence and reasoning reliability.',
      'Tradeoff: usually not the cheapest option here.',
    ].join('\n')
    expect(report.length).toBeGreaterThan(800)
    expect(checkOutboundFlood(report)).toEqual({ ok: true })
  })

  test('a very long natural-language reply passes regardless of length', () => {
    const paragraph =
      'The agent inspected the channel history, confirmed the deployment is healthy, ' +
      'and verified that no actionable error remains in the logs. '
    const text = paragraph.repeat(40)
    expect(text.length).toBeGreaterThan(3000)
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })

  test('a long code block passes', () => {
    const block = [
      '```ts',
      'export function checkOutboundFlood(text: string): OutboundFloodCheckResult {',
      "  const graphemes = Array.from(text.normalize('NFKC'))",
      '  const longestRun = findLongestRun(graphemes)',
      '  if (longestRun >= MAX_RUN) return { ok: false, reason: `run:${longestRun}` }',
      '  return { ok: true }',
      '}',
      '```',
    ].join('\n')
    const text = `${block}\n\nThat is the full implementation of the guard.`.repeat(6)
    expect(text.length).toBeGreaterThan(1500)
    expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })

  test('incidental short-range repetition in real text passes', () => {
    // The contiguous-span detector must not trip on the everyday repetition
    // that legitimate prose, markdown, and code carry: rules, ellipses,
    // laughter, table separators, indentation, alternating sequences.
    const benign = [
      'A long enough message to clear the length gate, followed by markdown.',
      'Intro\n\n---\n\nMore text after the horizontal rule and some closing words.',
      'Thinking..... okay, here is the answer to the question you asked me.',
      'That was funny — hahahaha — but here is the actual substantive answer now.',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      'Short alternating run abababababababababab inside an otherwise normal line.',
      ['def f():', '    a = 1', '    b = 2', '    c = a + b', '    return c'].join('\n'),
    ]
    for (const text of benign) expect(checkOutboundFlood(text)).toEqual({ ok: true })
  })
})
