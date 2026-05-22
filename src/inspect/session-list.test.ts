import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSessions, resolveSession } from './session-list'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-sessions-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function metaLine(origin: unknown): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'typeclaw.session-meta',
    data: { origin },
    timestamp: 0,
  })
}

function userLine(text: string, timestamp = 1000): string {
  return JSON.stringify({ type: 'message', message: { role: 'user', content: text, timestamp } })
}

async function writeSession(basename: string, lines: string[], mtimeSeconds: number): Promise<string> {
  const path = join(dir, basename)
  await writeFile(path, lines.join('\n') + '\n')
  await utimes(path, mtimeSeconds, mtimeSeconds)
  return path
}

describe('listSessions', () => {
  test('empty directory yields no sessions', async () => {
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions).toEqual([])
  })

  test('missing directory yields no sessions (fresh agent)', async () => {
    const sessions = await listSessions({ sessionsDir: join(dir, 'does-not-exist') })
    expect(sessions).toEqual([])
  })

  test('extracts session id from filename, origin from meta line, first prompt from first user', async () => {
    await writeSession(
      '2026-05-22T06-08-42-380Z_ses_abc123.jsonl',
      [metaLine({ kind: 'tui' }), userLine('hello world')],
      1_000_000,
    )
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions).toHaveLength(1)
    const s = sessions[0]!
    expect(s.sessionId).toBe('ses_abc123')
    expect(s.basename).toBe('2026-05-22T06-08-42-380Z_ses_abc123.jsonl')
    expect(s.origin).toEqual({ kind: 'tui' })
    expect(s.firstPrompt).toBe('hello world')
  })

  test('sorts by mtime desc', async () => {
    await writeSession('2025-01-01T00-00-00-000Z_ses_old.jsonl', [metaLine({ kind: 'tui' })], 100_000)
    await writeSession('2026-01-01T00-00-00-000Z_ses_new.jsonl', [metaLine({ kind: 'tui' })], 200_000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_new', 'ses_old'])
  })

  test('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await writeSession(`2026-05-22T0${i}-00-00-000Z_ses_${i}.jsonl`, [metaLine({ kind: 'tui' })], 1000 + i)
    }
    const sessions = await listSessions({ sessionsDir: dir, limit: 2 })
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_4', 'ses_3'])
  })

  test('sinceMs filters out older sessions', async () => {
    await writeSession('a_ses_old.jsonl', [metaLine({ kind: 'tui' })], 1000)
    await writeSession('b_ses_new.jsonl', [metaLine({ kind: 'tui' })], 2000)
    const sessions = await listSessions({ sessionsDir: dir, sinceMs: 1500 * 1000 })
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_new'])
  })

  test('skips non-jsonl entries and bad filenames with warnings', async () => {
    await writeFile(join(dir, 'random.txt'), 'not jsonl')
    await writeFile(join(dir, 'broken-name.jsonl'), '{}')
    await writeSession('2026-05-22T00-00-00-000Z_ses_ok.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_ok'])
    expect(warnings.some((w) => w.includes('broken-name.jsonl'))).toBe(true)
  })

  test('subagent system spawn with no user message → firstPrompt is null (renders as "system spawn" in selector)', async () => {
    await writeSession(
      '2026-05-22T00-00-00-000Z_ses_sub.jsonl',
      [metaLine({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_parent' })],
      1000,
    )
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions[0]?.firstPrompt).toBeNull()
  })

  test('channel origin with names preserved in summary', async () => {
    await writeSession(
      '2026-05-22T00-00-00-000Z_ses_chan.jsonl',
      [
        metaLine({
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T0123',
          workspaceName: 'Acme',
          chat: 'C0ABC',
          chatName: 'general',
          thread: null,
        }),
        userLine('@bot can you deploy'),
      ],
      1000,
    )
    const sessions = await listSessions({ sessionsDir: dir })
    const s = sessions[0]!
    if (s.origin?.kind !== 'channel') throw new Error('expected channel origin')
    expect(s.origin.workspaceName).toBe('Acme')
    expect(s.origin.chatName).toBe('general')
  })
})

describe('resolveSession', () => {
  test('exact session id match returns ok', async () => {
    await writeSession('a_ses_abc123.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, 'ses_abc123')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.summary.sessionId).toBe('ses_abc123')
  })

  test('unique short prefix resolves', async () => {
    await writeSession('a_ses_abcdef.jsonl', [metaLine({ kind: 'tui' })], 1000)
    await writeSession('b_ses_xyzxyz.jsonl', [metaLine({ kind: 'tui' })], 2000)
    const out = await resolveSession(dir, 'ses_abcd')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.summary.sessionId).toBe('ses_abcdef')
  })

  test('ambiguous prefix surfaces all matches', async () => {
    await writeSession('a_ses_abcd111.jsonl', [metaLine({ kind: 'tui' })], 1000)
    await writeSession('b_ses_abcd222.jsonl', [metaLine({ kind: 'tui' })], 2000)
    const out = await resolveSession(dir, 'ses_abcd')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('ambiguous')
    expect(out.matches.map((m) => m.sessionId).sort()).toEqual(['ses_abcd111', 'ses_abcd222'])
  })

  test('not found surfaces empty matches', async () => {
    await writeSession('a_ses_abc.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, 'ses_notthere')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })

  test('prefix shorter than 4 chars after ses_ is rejected without scanning', async () => {
    await writeSession('a_ses_abcdef.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, 'ses_a')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })

  test('non-ses_ prefix is rejected as not-found (no accidental random-substring matches)', async () => {
    await writeSession('a_ses_abcdef.jsonl', [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, 'abc')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })
})
