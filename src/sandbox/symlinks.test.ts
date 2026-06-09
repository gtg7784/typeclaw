import { describe, expect, test } from 'bun:test'

import { resolveSandboxSymlinks } from './symlinks'

const AGENT_DIR = '/agent'
const SANDBOX_HOME = '/tmp'

describe('resolveSandboxSymlinks', () => {
  test('expands a ~/ from against the SANDBOX home, not the real /root', () => {
    const ops = resolveSandboxSymlinks(
      AGENT_DIR,
      [{ from: '~/.metabase-cli', to: 'workspace/.metabase-cli' }],
      SANDBOX_HOME,
    )

    expect(ops).toEqual([{ target: '/agent/workspace/.metabase-cli', dest: '/tmp/.metabase-cli' }])
  })

  test('uses an absolute from verbatim (normalized)', () => {
    const ops = resolveSandboxSymlinks(AGENT_DIR, [{ from: '/root/.foo', to: '.foo' }], SANDBOX_HOME)

    expect(ops).toEqual([{ target: '/agent/.foo', dest: '/root/.foo' }])
  })

  test('normalizes a redundant absolute from', () => {
    const ops = resolveSandboxSymlinks(AGENT_DIR, [{ from: '/root/./.foo', to: '.foo' }], SANDBOX_HOME)

    expect(ops[0]?.dest).toBe('/root/.foo')
  })

  test('resolves to under the agent dir', () => {
    const ops = resolveSandboxSymlinks(AGENT_DIR, [{ from: '~/.x', to: 'workspace/cache/x' }], SANDBOX_HOME)

    expect(ops[0]?.target).toBe('/agent/workspace/cache/x')
  })

  test('returns [] for no specs', () => {
    expect(resolveSandboxSymlinks(AGENT_DIR, [], SANDBOX_HOME)).toEqual([])
  })

  test('honors a non-default sandbox home', () => {
    const ops = resolveSandboxSymlinks(AGENT_DIR, [{ from: '~/.foo', to: '.foo' }], '/home/agent')

    expect(ops[0]?.dest).toBe('/home/agent/.foo')
  })
})
