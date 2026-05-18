import { describe, expect, test } from 'bun:test'

import { applyManagedPath, buildManagedPath, resolveAgentId } from './managed-path'

describe('buildManagedPath', () => {
  test('produces a stable, hostname-agnostic path keyed on the agent id, versioned with v1', () => {
    expect(buildManagedPath('coder')).toBe('/typeclaw/v1/github/coder')
  })

  test('sanitizes identifiers containing characters not legal in a URL path segment', () => {
    expect(buildManagedPath('Mixed Case With Spaces')).toBe('/typeclaw/v1/github/mixed-case-with-spaces')
  })

  test('falls back to a non-empty default when the input sanitizes to empty', () => {
    expect(buildManagedPath('!!!')).toBe('/typeclaw/v1/github/agent')
  })
})

describe('resolveAgentId', () => {
  test('prefers TYPECLAW_CONTAINER_NAME-shaped containerName when present', () => {
    expect(resolveAgentId({ containerName: 'my-agent', agentDir: '/anything/else' })).toBe('my-agent')
  })

  test('falls back to agentDir basename when containerName is missing', () => {
    expect(resolveAgentId({ agentDir: '/Users/x/coder' })).toBe('coder')
  })

  test('ignores empty/whitespace containerName', () => {
    expect(resolveAgentId({ containerName: '   ', agentDir: '/x/y/folder' })).toBe('folder')
  })
})

describe('applyManagedPath', () => {
  test('appends the marker to a bare host-only URL (the cloudflare-quick case)', () => {
    expect(applyManagedPath('https://random.trycloudflare.com', '/typeclaw/v1/github/coder')).toBe(
      'https://random.trycloudflare.com/typeclaw/v1/github/coder',
    )
  })

  test('appends the marker to a host-with-trailing-slash URL', () => {
    expect(applyManagedPath('https://random.trycloudflare.com/', '/typeclaw/v1/github/coder')).toBe(
      'https://random.trycloudflare.com/typeclaw/v1/github/coder',
    )
  })

  test('leaves a user-set URL with a non-trivial path untouched (operator owns their URL)', () => {
    expect(applyManagedPath('https://my.proxy.example.com/agent/gh', '/typeclaw/v1/github/coder')).toBe(
      'https://my.proxy.example.com/agent/gh',
    )
  })

  test('returns the input unchanged when it cannot be parsed as a URL', () => {
    expect(applyManagedPath('not-a-url', '/typeclaw/v1/github/coder')).toBe('not-a-url')
  })
})
