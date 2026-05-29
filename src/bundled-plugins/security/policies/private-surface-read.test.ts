import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

describe('private-surface-read guard — free-text field scoping (no false positives)', () => {
  test('does not block a bare hidden-dir NAME in a free-text field', () => {
    expect(check('channel_reply', { text: 'memory' })).toBeUndefined()
    expect(check('websearch', { query: 'workspace' })).toBeUndefined()
    expect(check('grep', { pattern: 'sessions', path: 'public' })).toBeUndefined()
    expect(check('look_at_channel_attachment', { prompt: 'sessions' })).toBeUndefined()
  })

  test('does not block a path-LIKE value in a free-text field', () => {
    expect(check('channel_reply', { text: 'see workspace/notes.md for details' })).toBeUndefined()
    expect(check('grep', { pattern: 'memory/topics', path: 'public' })).toBeUndefined()
    expect(check('grep', { pattern: 'token', path: 'public', glob: 'workspace/*.md' })).toBeUndefined()
    expect(check('edit', { path: 'public/x.md', edits: [{ oldText: 'workspace/a', newText: 'memory/b' }] })).toBe(
      undefined,
    )
    expect(check('append', { topic: 'workspace', body: 'about memory' })).toBeUndefined()
  })

  test('STILL blocks a hidden path in a genuine path field (scoping did not open a hole)', () => {
    expect(check('read', { path: 'memory' })?.block).toBe(true)
    expect(check('read', { path: 'workspace/notes.md' })?.block).toBe(true)
    expect(check('grep', { pattern: 'token', path: 'sessions' })?.block).toBe(true)
    expect(check('look_at', { images: [{ path: 'memory/x.png' }] })?.block).toBe(true)
    expect(check('channel_send', { text: 'memory', attachments: [{ path: 'sessions/s.jsonl' }] })?.block).toBe(true)
  })

  test('fail-closed: an UNKNOWN key on an unknown tool is still scanned', () => {
    expect(check('some_new_plugin_tool', { srcPath: 'memory/x' })?.block).toBe(true)
    expect(check('some_new_plugin_tool', { nested: { target: 'workspace/y' } })?.block).toBe(true)
  })

  test('does not block an attachment display filename that equals a hidden-dir name', () => {
    expect(
      check('channel_send', {
        text: 'see attached',
        attachments: [{ path: 'public/report.pdf', filename: 'memory' }],
      }),
    ).toBeUndefined()
    expect(check('channel_reply', { attachments: [{ path: 'public/x.md', filename: 'sessions' }] })).toBeUndefined()
    expect(check('channel_fetch_attachment', { attachment_id: 1, filename: 'workspace' })).toBeUndefined()
  })

  test('STILL blocks a hidden attachments[].path even when filename is exempt', () => {
    expect(
      check('channel_send', {
        attachments: [{ path: 'memory/leak.md', filename: 'report.pdf' }],
      })?.block,
    ).toBe(true)
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

  test('a guest may read, write, and list the public/ zone', () => {
    expect(check('read', { path: 'public/notes.md' })).toBeUndefined()
    expect(check('write', { path: 'public/report.md' })).toBeUndefined()
    expect(check('ls', { path: 'public' })).toBeUndefined()
    expect(check('ls', { path: '/agent/public' })).toBeUndefined()
  })
})

describe('private-surface-read guard — traversal + scope', () => {
  test('defeats path traversal back into a hidden dir', () => {
    expect(check('read', { path: 'public/../workspace/x' })?.block).toBe(true)
    expect(check('read', { path: './workspace/./x' })?.block).toBe(true)
  })

  test('covers the secret files across ALL tools (one deny-list, not delegated to secretExfilRead)', () => {
    expect(check('read', { path: '/agent/.env' })?.block).toBe(true)
    expect(check('read', { path: '.env' })?.block).toBe(true)
    expect(check('edit', { path: '/agent/.env' })?.block).toBe(true)
    expect(check('write', { path: 'secrets.json' })?.block).toBe(true)
    expect(check('look_at', { images: [{ path: '/agent/secrets.json' }] })?.block).toBe(true)
    expect(check('channel_send', { attachments: [{ path: '/agent/.env' }] })?.block).toBe(true)
  })

  test('a secret file matches exactly, not by prefix (.env does not block .envrc-style siblings)', () => {
    expect(check('read', { path: '/agent/.environment' })).toBeUndefined()
    expect(check('read', { path: '/agent/secrets.json.bak' })).toBeUndefined()
  })

  test('empty deny-list (trusted+) is a no-op for every tool', () => {
    expect(check('read', { path: 'workspace/notes.md' }, emptyHidden)).toBeUndefined()
    expect(check('look_at', { images: [{ path: 'workspace/x' }] }, emptyHidden)).toBeUndefined()
  })

  test('bash is never blocked here (its access is contained by the bwrap sandbox)', () => {
    expect(check('bash', { command: 'cat workspace/notes.md' })).toBeUndefined()
  })
})

describe('private-surface-read guard — symlink bypass defense', () => {
  // Real filesystem: the bug is that lexical path.resolve does not follow
  // symlinks. A guest plants public/leak -> ../<hidden> via sandboxed bash,
  // then reads it back through a non-bash tool whose path lexically lands in
  // guest-visible public/. The guard must realpath the candidate and catch it.
  function makeAgentWithSymlinks(): { agentDir: string; hidden: HiddenPaths } {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'typeclaw-symlink-guard-')))
    for (const dir of ['workspace', 'memory', 'sessions', 'public']) {
      mkdirSync(path.join(agentDir, dir), { recursive: true })
    }
    writeFileSync(path.join(agentDir, '.env'), 'SECRET=1')
    writeFileSync(path.join(agentDir, 'memory', 'topic.md'), 'private')
    symlinkSync(path.join(agentDir, '.env'), path.join(agentDir, 'public', 'env-link'))
    symlinkSync(path.join(agentDir, 'memory'), path.join(agentDir, 'public', 'mem-link'))
    return {
      agentDir,
      hidden: {
        dirs: ['workspace', 'memory', 'sessions'].map((d) => path.join(agentDir, d)),
        files: ['.env', 'secrets.json'].map((f) => path.join(agentDir, f)),
      },
    }
  }

  test('blocks a non-bash read of a public/ symlink pointing at a hidden FILE', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    const result = checkPrivateSurfaceReadGuard({ tool: 'read', args: { path: 'public/env-link' }, agentDir, hidden })
    expect(result?.block).toBe(true)
  })

  test('blocks a non-bash read THROUGH a public/ symlink pointing at a hidden DIR', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    // public/mem-link -> memory/, so public/mem-link/topic.md resolves into memory/
    const result = checkPrivateSurfaceReadGuard({
      tool: 'read',
      args: { path: 'public/mem-link/topic.md' },
      agentDir,
      hidden,
    })
    expect(result?.block).toBe(true)
  })

  test('blocks the symlink via a NESTED arg shape (look_at images[].path)', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    const result = checkPrivateSurfaceReadGuard({
      tool: 'look_at',
      args: { images: [{ path: 'public/env-link' }] },
      agentDir,
      hidden,
    })
    expect(result?.block).toBe(true)
  })

  test('still ALLOWS a genuine non-symlink file inside public/', () => {
    const { agentDir, hidden } = makeAgentWithSymlinks()
    writeFileSync(path.join(agentDir, 'public', 'real.md'), 'shareable')
    const result = checkPrivateSurfaceReadGuard({ tool: 'read', args: { path: 'public/real.md' }, agentDir, hidden })
    expect(result).toBeUndefined()
  })
})
