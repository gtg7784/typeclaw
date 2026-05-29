import { describe, expect, test } from 'bun:test'

import type { HiddenPaths } from '@/sandbox'

import { checkPrivateSurfaceReadGuard } from './private-surface-read'

const AGENT = '/agent'
const guestHidden: HiddenPaths = {
  dirs: ['/agent/workspace', '/agent/memory', '/agent/sessions'],
  files: ['/agent/.env', '/agent/secrets.json'],
}
const emptyHidden: HiddenPaths = { dirs: [], files: [] }

function check(tool: string, args: Record<string, unknown>, hidden: HiddenPaths = guestHidden) {
  return checkPrivateSurfaceReadGuard({ tool, args, agentDir: AGENT, hidden })
}

describe('private-surface-read guard — builtin file tools', () => {
  test('blocks reading a file inside a hidden dir (relative and absolute)', () => {
    expect(check('read', { path: 'workspace/notes.md' })?.block).toBe(true)
    expect(check('read', { path: '/agent/workspace/notes.md' })?.block).toBe(true)
    expect(check('read', { path: 'memory/topics/x.md' })?.block).toBe(true)
    expect(check('read', { path: 'sessions/latest.jsonl' })?.block).toBe(true)
  })

  test('blocks grep/find/ls/edit/write against the hidden surface', () => {
    expect(check('grep', { pattern: 'token', path: 'workspace' })?.block).toBe(true)
    expect(check('find', { path: '/agent/memory' })?.block).toBe(true)
    expect(check('ls', { path: 'sessions' })?.block).toBe(true)
    expect(check('edit', { path: 'workspace/x.ts' })?.block).toBe(true)
    expect(check('write', { path: 'workspace/x.ts' })?.block).toBe(true)
  })
})

describe('private-surface-read guard — fail-closed across ALL tools (not a whitelist)', () => {
  test('blocks find_entry reading a hidden transcript via top-level path', () => {
    expect(check('find_entry', { path: '/agent/sessions/s.jsonl', entryId: 'x' })?.block).toBe(true)
  })

  test('blocks look_at reading a hidden file via NESTED images[].path', () => {
    expect(check('look_at', { images: [{ path: '/agent/sessions/s.jsonl' }] })?.block).toBe(true)
    expect(check('look_at', { images: [{ url: 'https://x' }, { path: 'memory/secret.md' }] })?.block).toBe(true)
  })

  test('blocks channel_send / channel_reply exfil of a hidden file via NESTED attachments[].path', () => {
    expect(check('channel_send', { adapter: 'slack-bot', attachments: [{ path: 'workspace/leak.md' }] })?.block).toBe(
      true,
    )
    expect(check('channel_reply', { attachments: [{ path: '/agent/memory/x.md' }] })?.block).toBe(true)
  })

  test('blocks an unknown/future tool that takes a hidden path (no whitelist to slip past)', () => {
    expect(check('some_new_plugin_tool', { input: { nested: { file: 'sessions/x.jsonl' } } })?.block).toBe(true)
  })
})

describe('private-surface-read guard — false-positive control', () => {
  test('does not block prose args that merely mention a dir name without a separator', () => {
    expect(check('channel_send', { text: 'tell me about the workspace and memory' })).toBeUndefined()
    expect(check('find_entry', { entryId: 'sessions-summary', path: 'public/x.jsonl' })).toBeUndefined()
  })

  test('does not block a sibling dir that only prefix-matches a hidden name', () => {
    expect(check('read', { path: 'workspace-notes/x.md' })).toBeUndefined()
    expect(check('read', { path: 'sessions-archive/x.md' })).toBeUndefined()
  })

  test('allows reads outside the hidden surface', () => {
    expect(check('read', { path: 'public/readme.md' })).toBeUndefined()
    expect(check('read', { path: '/agent/node_modules/x/index.js' })).toBeUndefined()
  })
})

describe('private-surface-read guard — traversal + scope', () => {
  test('defeats path traversal back into a hidden dir', () => {
    expect(check('read', { path: 'public/../workspace/x' })?.block).toBe(true)
    expect(check('read', { path: './workspace/./x' })?.block).toBe(true)
  })

  test('does NOT cover the secret files (owned by the secretExfilRead guard)', () => {
    expect(check('read', { path: '/agent/.env' })).toBeUndefined()
    expect(check('read', { path: '/agent/secrets.json' })).toBeUndefined()
  })

  test('empty deny-list (trusted+) is a no-op for every tool', () => {
    expect(check('read', { path: 'workspace/notes.md' }, emptyHidden)).toBeUndefined()
    expect(check('look_at', { images: [{ path: 'workspace/x' }] }, emptyHidden)).toBeUndefined()
  })

  test('bash is never blocked here (its access is contained by the bwrap sandbox)', () => {
    expect(check('bash', { command: 'cat workspace/notes.md' })).toBeUndefined()
  })
})
