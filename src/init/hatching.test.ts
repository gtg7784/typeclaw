import { describe, expect, test } from 'bun:test'

import { buildHatchingPrompt, HATCHING_GREETING } from './hatching'

describe('buildHatchingPrompt', () => {
  test('greeting is always the last line', () => {
    const prompt = buildHatchingPrompt()
    expect(prompt.endsWith(HATCHING_GREETING)).toBe(true)
  })

  test('without typeclawJsonContent, instructs the agent to read the file', () => {
    const prompt = buildHatchingPrompt()
    expect(prompt).toContain('Read `typeclaw.json`')
    expect(prompt).not.toContain('<current-typeclaw-json>')
    expect(prompt).not.toContain('in the SAME assistant message')
  })

  test('with typeclawJsonContent, inlines the content and instructs parallel edit', () => {
    const json = '{\n  "models": {\n    "default": "openai-codex/gpt-5.4-mini"\n  }\n}\n'
    const prompt = buildHatchingPrompt({ typeclawJsonContent: json })

    expect(prompt).toContain('<current-typeclaw-json>')
    expect(prompt).toContain(json)
    expect(prompt).toContain('</current-typeclaw-json>')
    expect(prompt).toContain('in the SAME assistant message')
    expect(prompt).toContain('`edit` `typeclaw.json`')
    expect(prompt).not.toMatch(/^Read `typeclaw\.json`/m)
  })

  test('inlined content preserves bytes verbatim (no JSON re-serialization)', () => {
    // given: a typeclaw.json with formatting quirks the agent's `edit` will anchor on
    const json = '{\n  "alias": ["existing"],\n  "models":   {"default":"x/y"}\n}\n'

    // when
    const prompt = buildHatchingPrompt({ typeclawJsonContent: json })

    // then: the exact byte sequence must appear so `edit` can match it
    expect(prompt).toContain(json)
  })

  test('passing undefined typeclawJsonContent behaves like no options', () => {
    const a = buildHatchingPrompt()
    const b = buildHatchingPrompt({ typeclawJsonContent: undefined })
    expect(a).toBe(b)
  })

  test('Q3 instructs writing a kaomoji-affinity line into SOUL.md when tone leans cute/warm', () => {
    // given/when
    const prompt = buildHatchingPrompt()

    // then: the kaomoji-affinity branch must mention the bundled skill name
    // so the agent knows which skill it is wiring up by writing the SOUL line.
    expect(prompt).toContain('typeclaw-kaomoji')
    expect(prompt).toContain('(◕‿◕✿)')
    expect(prompt).toContain('kaomojis lead')
  })

  test('content is wrapped so the agent can locate it deterministically', () => {
    const json = '{"a":1}'
    const prompt = buildHatchingPrompt({ typeclawJsonContent: json })
    const start = prompt.indexOf('<current-typeclaw-json>')
    const end = prompt.indexOf('</current-typeclaw-json>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(prompt.slice(start, end)).toContain(json)
  })
})
