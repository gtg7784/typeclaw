import { describe, expect, test } from 'bun:test'

import { type MatchRule, parseMatchRule } from './match-rule'

describe('parseMatchRule — accepted forms', () => {
  const cases: { input: string; expected: MatchRule }[] = [
    { input: 'tui', expected: { kind: 'tui' } },
    { input: 'cron', expected: { kind: 'cron' } },
    { input: 'subagent', expected: { kind: 'subagent' } },
    { input: 'subagent:memory-logger', expected: { kind: 'subagent', subagent: 'memory-logger' } },
    { input: '*', expected: { kind: 'wildcard' } },
    { input: 'slack:*', expected: { kind: 'channel', platform: 'slack' } },
    { input: 'slack:T0123', expected: { kind: 'channel', platform: 'slack', workspace: 'T0123' } },
    {
      input: 'slack:T0123/C0ABCDE',
      expected: { kind: 'channel', platform: 'slack', workspace: 'T0123', chat: 'C0ABCDE' },
    },
    { input: 'slack:dm/*', expected: { kind: 'channel', platform: 'slack', bucket: 'dm' } },
    {
      input: 'slack:dm/D0ABCDE',
      expected: { kind: 'channel', platform: 'slack', bucket: 'dm', chat: 'D0ABCDE' },
    },
    {
      input: 'slack:T0123 author:U_ME',
      expected: { kind: 'channel', platform: 'slack', workspace: 'T0123', author: 'U_ME' },
    },
    {
      input: 'slack:T0123/C0ABCDE author:U_ME',
      expected: { kind: 'channel', platform: 'slack', workspace: 'T0123', chat: 'C0ABCDE', author: 'U_ME' },
    },
    { input: 'discord:9999', expected: { kind: 'channel', platform: 'discord', workspace: '9999' } },
    { input: 'discord:dm/*', expected: { kind: 'channel', platform: 'discord', bucket: 'dm' } },
    { input: 'telegram:42', expected: { kind: 'channel', platform: 'telegram', workspace: '42' } },
    { input: 'kakao:dm/*', expected: { kind: 'channel', platform: 'kakao', bucket: 'dm' } },
    { input: 'kakao:group/*', expected: { kind: 'channel', platform: 'kakao', bucket: 'group' } },
    { input: 'kakao:open/*', expected: { kind: 'channel', platform: 'kakao', bucket: 'open' } },
    { input: 'github:acme/project', expected: { kind: 'channel', platform: 'github', workspace: 'acme/project' } },
    {
      input: 'github:acme/project/issue:42',
      expected: { kind: 'channel', platform: 'github', workspace: 'acme/project', chat: 'issue:42' },
    },
    {
      input: 'github:acme/project author:12345',
      expected: { kind: 'channel', platform: 'github', workspace: 'acme/project', author: '12345' },
    },
  ]
  for (const { input, expected } of cases) {
    test(`parses '${input}'`, () => {
      const result = parseMatchRule(input)
      if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
      expect(result.value).toEqual(expected)
    })
  }
})

describe('parseMatchRule — rejected forms', () => {
  const cases: { input: string; reason: RegExp }[] = [
    { input: 'slack:*/*', reason: /nonsensical|redundant/i },
    { input: 'slack:T0123/*', reason: /redundant/i },
    { input: 'slack:*/C0ABCDE', reason: /nonsensical|wildcard workspace/i },
    { input: 'slack:im/*', reason: /'im' renamed|use 'slack:dm/i },
    { input: 'slack:im/D0ABC', reason: /'im' renamed/i },
    { input: 'team:T0123', reason: /legacy prefix 'team'/ },
    { input: 'guild:9999', reason: /legacy prefix 'guild'/ },
    { input: 'tg:42', reason: /legacy prefix 'tg'/ },
    { input: 'slack:', reason: /missing a coordinate/ },
    { input: 'kakao:dm', reason: /requires a chat id or '\*'/ },
    { input: 'slack:T0123 autor:U_ME', reason: /unknown qualifier 'autor:'.*Did you mean 'author:'/ },
    { input: 'author:U_ME', reason: /channel scope|unknown scope/i },
    { input: 'slack:T0123 author:', reason: /'author:' must have a value/ },
    { input: ' tui', reason: /leading or trailing whitespace/i },
    { input: 'tui ', reason: /leading or trailing whitespace/i },
    { input: 'slack:T0123  author:U', reason: /exactly one space/i },
    { input: '', reason: /must not have leading or trailing whitespace|empty/i },
    { input: 'slak:T0123', reason: /did you mean 'slack'/ },
    { input: 'subagent:Bad-Name', reason: /must match/ },
    { input: 'tui author:U_ME', reason: /'author:' requires a channel scope/ },
    { input: '* author:U_ME', reason: /requires a specific channel scope/ },
    { input: 'discord:group/*', reason: /'group' is only valid for kakao/ },
    { input: 'discord:open/*', reason: /'open' is only valid for kakao/ },
    { input: 'github:acme', reason: /owner\/repo/ },
    { input: 'github:acme/*', reason: /not supported/ },
    { input: 'github:acme/project/issue:42/extra', reason: /single segment/ },
  ]
  for (const { input, reason } of cases) {
    test(`rejects '${input}'`, () => {
      const result = parseMatchRule(input)
      if (result.ok) throw new Error(`expected failure for '${input}', got: ${JSON.stringify(result.value)}`)
      expect(result.error).toMatch(reason)
    })
  }
})

describe('parseMatchRule — author qualifier semantics', () => {
  test('author cannot appear twice', () => {
    const r = parseMatchRule('slack:T0123 author:U_A author:U_B')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/may not appear more than once/)
  })

  test('author requires a channel scope, not subagent', () => {
    const r = parseMatchRule('subagent author:U_ME')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/requires a channel scope/)
  })
})
