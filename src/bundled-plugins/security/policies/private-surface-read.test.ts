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

describe('private-surface-read guard', () => {
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

  test('does NOT cover the secret files (owned by the secretExfilRead guard)', () => {
    expect(check('read', { path: '.env' })).toBeUndefined()
    expect(check('read', { path: '/agent/secrets.json' })).toBeUndefined()
  })

  test('defeats path traversal back into a hidden dir', () => {
    expect(check('read', { path: 'public/../workspace/x' })?.block).toBe(true)
    expect(check('read', { path: './workspace/./x' })?.block).toBe(true)
  })

  test('allows reads outside the hidden surface', () => {
    expect(check('read', { path: 'public/readme.md' })).toBeUndefined()
    expect(check('read', { path: 'package.json' })).toBeUndefined()
    expect(check('read', { path: '/agent/node_modules/x/index.js' })).toBeUndefined()
  })

  test('does not block a path that only prefix-matches a hidden dir name', () => {
    expect(check('read', { path: 'workspace-notes/x.md' })).toBeUndefined()
    expect(check('read', { path: 'sessions-archive.md' })).toBeUndefined()
  })

  test('empty deny-list (trusted+) is a no-op for every tool', () => {
    expect(check('read', { path: 'workspace/notes.md' }, emptyHidden)).toBeUndefined()
    expect(check('read', { path: '.env' }, emptyHidden)).toBeUndefined()
  })

  test('ignores non-filesystem tools', () => {
    expect(check('bash', { command: 'cat workspace/notes.md' })).toBeUndefined()
    expect(check('websearch', { query: 'workspace/notes.md' })).toBeUndefined()
  })
})
