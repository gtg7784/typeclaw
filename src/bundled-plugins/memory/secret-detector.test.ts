import { describe, expect, test } from 'bun:test'

import { detectSecrets, SECRET_RULES } from './secret-detector'

// Test fixtures avoid embedding full literal token strings so that upstream
// secret scanners (GitHub push protection, TruffleHog, gitleaks) do not flag
// this file. Each fixture concatenates the recognizable prefix with a body
// that satisfies our regex's character class but reads as obvious filler.
function fakeToken(prefix: string, length: number): string {
  return prefix + 'X'.repeat(length)
}

describe('detectSecrets', () => {
  test('returns an empty list for ordinary memory fragment text', () => {
    const fragment = [
      '<!-- fragment source=ses_abc entry=11111111 -->',
      '## Bug Fix: Stale Item in Notification Banner',
      '**Project:** Acme App (acme-bugs channel C0123456789)',
      '**Issue:** stale item appearing in notification banner',
      '',
    ].join('\n')

    expect(detectSecrets(fragment)).toEqual([])
  })

  test('flags a GitHub fine-grained PAT (the leak pattern this rule was created for)', () => {
    const matches = detectSecrets(`GH_TOKEN=${fakeToken('github_' + 'pat_', 80)}`)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.rule === 'github-pat')).toBe(true)
  })

  test('flags GitHub classic PATs (ghp_ prefix)', () => {
    expect(detectSecrets(`token=${fakeToken('ghp' + '_', 36)}`)).toHaveLength(1)
  })

  test('flags Slack bot tokens (xoxb- prefix)', () => {
    expect(detectSecrets(`SLACK_BOT_TOKEN=${fakeToken('xo' + 'xb-', 40)}`).length).toBeGreaterThan(0)
  })

  test('flags Anthropic API keys', () => {
    expect(detectSecrets(`KEY=${fakeToken('sk-' + 'ant-', 30)}`).length).toBeGreaterThan(0)
  })

  test('flags AWS access key ids', () => {
    expect(detectSecrets(`aws_access_key_id=${'AK' + 'IA' + 'XXXXXXXXXXXXXXXX'}`)).toHaveLength(1)
  })

  test('flags Google API keys', () => {
    expect(detectSecrets(`GOOGLE_API_KEY=${'AI' + 'za' + 'X'.repeat(35)}`).length).toBeGreaterThan(0)
  })

  test('flags PEM-encoded private keys', () => {
    expect(
      detectSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'),
    ).toHaveLength(1)
  })

  test('does not flag the literal substring "github_pat_" without enough trailing entropy', () => {
    expect(detectSecrets('the prefix github_' + 'pat_ is the discriminator')).toEqual([])
  })

  test('does not flag the variable NAME alone (only the value matters)', () => {
    expect(detectSecrets('the env var GH_TOKEN holds the credential')).toEqual([])
    expect(detectSecrets('SLACK_BOT_TOKEN is configured in .env')).toEqual([])
  })

  test('reports the rule name and a stable index for the first match', () => {
    const prefix = 'noise '.repeat(10)
    const content = `${prefix}${fakeToken('sk-' + 'ant-', 30)}`
    const matches = detectSecrets(content)
    expect(matches[0]!.rule).toBe('anthropic-key')
    expect(matches[0]!.index).toBe(prefix.length)
  })

  test('detects multiple distinct rule violations in the same content', () => {
    const content = [`token=${fakeToken('ghp' + '_', 36)}`, `aws=${'AK' + 'IA' + 'XXXXXXXXXXXXXXXX'}`].join('\n')
    const matches = detectSecrets(content)
    expect(matches.map((m) => m.rule).sort()).toEqual(['aws-access-key', 'github-classic-pat'])
  })

  test('every rule has a unique name (defense against copy-paste duplication)', () => {
    const names = SECRET_RULES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
