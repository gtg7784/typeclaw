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

const UUID_A = '019dda40-4ba8-7472-9b06-e72b2b994be5'
const UUID_B = '019e2c2e-a32e-7230-9f79-62ffe148fec1'
const UUID_OLD = '019dda40-0000-7000-9000-000000000000'
const UUID_NEW = '019e4d7d-bfb4-745b-9990-6b7b364bd1bd'

describe('listSessions', () => {
  test('empty directory yields no sessions', async () => {
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions).toEqual([])
  })

  test('missing directory yields no sessions (fresh agent)', async () => {
    const sessions = await listSessions({ sessionsDir: join(dir, 'does-not-exist') })
    expect(sessions).toEqual([])
  })

  test('extracts session id from pi-coding-agent filename format (ISO timestamp + UUIDv7)', async () => {
    const basename = `2026-04-29T17-19-00-008Z_${UUID_A}.jsonl`
    await writeSession(basename, [metaLine({ kind: 'tui' }), userLine('hello world')], 1_000_000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions).toHaveLength(1)
    const s = sessions[0]!
    expect(s.sessionId).toBe(UUID_A)
    expect(s.basename).toBe(basename)
    expect(s.origin).toEqual({ kind: 'tui' })
    expect(s.firstPrompt).toBe('hello world')
  })

  test('sorts by mtime desc', async () => {
    await writeSession(`2025-01-01T00-00-00-000Z_${UUID_OLD}.jsonl`, [metaLine({ kind: 'tui' })], 100_000)
    await writeSession(`2026-01-01T00-00-00-000Z_${UUID_NEW}.jsonl`, [metaLine({ kind: 'tui' })], 200_000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_NEW, UUID_OLD])
  })

  test('respects limit', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = `019e0000-0000-7000-9000-00000000000${i}`
      ids.push(id)
      await writeSession(`2026-05-22T0${i}-00-00-000Z_${id}.jsonl`, [metaLine({ kind: 'tui' })], 1000 + i)
    }
    const sessions = await listSessions({ sessionsDir: dir, limit: 2 })
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.sessionId)).toEqual([ids[4]!, ids[3]!])
  })

  test('sinceMs filters out older sessions', async () => {
    await writeSession(`a_${UUID_OLD}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    await writeSession(`b_${UUID_NEW}.jsonl`, [metaLine({ kind: 'tui' })], 2000)
    const sessions = await listSessions({ sessionsDir: dir, sinceMs: 1500 * 1000 })
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_NEW])
  })

  test('skips non-jsonl entries and bad filenames with warnings', async () => {
    await writeFile(join(dir, 'random.txt'), 'not jsonl')
    await writeFile(join(dir, '_.jsonl'), '{}')
    await writeSession(`2026-05-22T00-00-00-000Z_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_A])
    expect(warnings.some((w) => w.includes('_.jsonl'))).toBe(true)
  })

  test('subagent system spawn with no user message → firstPrompt is null (renders as "system spawn" in selector)', async () => {
    await writeSession(
      `2026-05-22T00-00-00-000Z_${UUID_A}.jsonl`,
      [metaLine({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: UUID_B })],
      1000,
    )
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions[0]?.firstPrompt).toBeNull()
  })

  test('strips the injected <current-time> anchor from the first-prompt hint', async () => {
    const text = '<current-time>2026-06-04T22:36:14+09:00 (Asia/Seoul, Thursday)</current-time>\n\nfix the parser'
    await writeSession(`2026-06-04T00-00-00-000Z_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' }), userLine(text)], 1000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions[0]?.firstPrompt).toBe('fix the parser')
  })

  test('a turn that is only the time anchor falls through to the next real user message', async () => {
    const anchorOnly = '<current-time>2026-06-04T22:36:14+09:00 (Asia/Seoul, Thursday)</current-time>'
    await writeSession(
      `2026-06-04T00-00-00-000Z_${UUID_A}.jsonl`,
      [metaLine({ kind: 'tui' }), userLine(anchorOnly, 1000), userLine(`${anchorOnly}\n\nthe real ask`, 2000)],
      1000,
    )
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions[0]?.firstPrompt).toBe('the real ask')
  })

  test('strips the <hatching> bootstrap block from the first-prompt hint', async () => {
    const text = '<hatching>secret ritual</hatching>\n\nactual first message'
    await writeSession(`2026-06-04T00-00-00-000Z_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' }), userLine(text)], 1000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions[0]?.firstPrompt).toBe('actual first message')
  })

  test('channel origin with names preserved in summary', async () => {
    await writeSession(
      `2026-05-22T00-00-00-000Z_${UUID_A}.jsonl`,
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

  test('regression: production filename from pi-coding-agent (no ses_ prefix) does not get skipped', async () => {
    const basename = `2026-04-29T17-19-00-008Z_${UUID_A}.jsonl`
    await writeSession(basename, [metaLine({ kind: 'tui' })], 1000)
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions).toHaveLength(1)
    expect(warnings.filter((w) => w.includes('unexpected name'))).toEqual([])
  })

  test('regression: legacy bare-UUID filename (pre-May-2026 channel session) is not skipped', async () => {
    const basename = `${UUID_A}.jsonl`
    await writeSession(basename, [metaLine({ kind: 'tui' }), userLine('legacy session')], 1000)
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe(UUID_A)
    expect(sessions[0]?.basename).toBe(basename)
    expect(sessions[0]?.firstPrompt).toBe('legacy session')
    expect(warnings.filter((w) => w.includes('unexpected name'))).toEqual([])
  })

  test('legacy bare-UUID and ISO_UUID files coexist in the same directory', async () => {
    await writeSession(`${UUID_OLD}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    await writeSession(`2026-05-22T00-00-00-000Z_${UUID_NEW}.jsonl`, [metaLine({ kind: 'tui' })], 2000)
    const sessions = await listSessions({ sessionsDir: dir })
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_NEW, UUID_OLD])
  })

  test('rejects filename with only an underscore (_.jsonl) and no id', async () => {
    await writeFile(join(dir, '_.jsonl'), '{}')
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions).toEqual([])
    expect(warnings.some((w) => w.includes('_.jsonl'))).toBe(true)
  })

  test('rejects filename with only an extension (.jsonl) and no id', async () => {
    await writeFile(join(dir, '.jsonl'), '{}')
    const warnings: string[] = []
    const sessions = await listSessions({ sessionsDir: dir, onWarn: (m) => warnings.push(m) })
    expect(sessions).toEqual([])
    expect(warnings.some((w) => w.includes('.jsonl'))).toBe(true)
  })
})

describe('resolveSession', () => {
  test('exact session id match returns ok', async () => {
    await writeSession(`a_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, UUID_A)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.summary.sessionId).toBe(UUID_A)
  })

  test('unique short prefix resolves', async () => {
    const idA = '019dda40-4ba8-7472-9b06-e72b2b994be5'
    const idB = '019e2c2e-a32e-7230-9f79-62ffe148fec1'
    await writeSession(`a_${idA}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    await writeSession(`b_${idB}.jsonl`, [metaLine({ kind: 'tui' })], 2000)
    const out = await resolveSession(dir, '019dda40')
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.summary.sessionId).toBe(idA)
  })

  test('ambiguous prefix surfaces all matches', async () => {
    const idA = '019dda40-aaaa-7000-9000-000000000001'
    const idB = '019dda40-bbbb-7000-9000-000000000002'
    await writeSession(`a_${idA}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    await writeSession(`b_${idB}.jsonl`, [metaLine({ kind: 'tui' })], 2000)
    const out = await resolveSession(dir, '019dda40')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('ambiguous')
    expect(out.matches.map((m) => m.sessionId).sort()).toEqual([idA, idB])
  })

  test('not found surfaces empty matches', async () => {
    await writeSession(`a_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, 'deadbeef-0000-7000-9000-000000000000')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })

  test('prefix shorter than 4 chars is rejected without scanning', async () => {
    await writeSession(`a_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, '019')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })

  test('prefix containing path separators is rejected (no path traversal)', async () => {
    await writeSession(`a_${UUID_A}.jsonl`, [metaLine({ kind: 'tui' })], 1000)
    const out = await resolveSession(dir, '../etc')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toBe('not-found')
  })
})
