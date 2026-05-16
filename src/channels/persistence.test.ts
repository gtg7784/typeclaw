import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-persistence-'))
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('loadChannelSessions', () => {
  test('returns empty list when file is missing', async () => {
    const dir = await tempDir()
    const out = await loadChannelSessions(dir, silentLogger)
    expect(out).toEqual([])
  })

  test('migrates a v3 file to v4 with unknown lastInboundAt sentinel', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 3, sessions: records }))
    const out = await loadChannelSessions(dir, silentLogger)
    expect(out).toHaveLength(1)
    expect(out[0]?.sessionId).toBe('ses_abc')
    expect(out[0]?.sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_abc.jsonl')
    expect(out[0]?.lastInboundAt).toBe(0)
  })

  test('loads a v4 file without clobbering lastInboundAt', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        lastInboundAt: 1234,
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 4, sessions: records }))

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out).toHaveLength(1)
    expect(out[0]?.lastInboundAt).toBe(1234)
  })

  test('migrates a v2 file by globbing the sessions directory for *_<sessionId>.jsonl', async () => {
    // given: a v2 mapping plus an actual session file written by pi-coding-agent
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await mkdir(join(dir, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'sessions', '2026-05-02T16-56-52-380Z_ses_abc.jsonl'), '{"type":"session"}\n')
    const records = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 2, sessions: records }))

    // when: load runs the v2→v3→v4 migration chain
    const out = await loadChannelSessions(dir, silentLogger)

    // then: the actual basename is attached and the unknown-inbound sentinel is set
    expect(out).toHaveLength(1)
    expect(out[0]?.sessionId).toBe('ses_abc')
    expect(out[0]?.sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_abc.jsonl')
    expect(out[0]?.lastInboundAt).toBe(0)
  })

  test('v2 migration leaves sessionFile unset and warns when the on-disk file is missing', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await mkdir(join(dir, 'sessions'), { recursive: true })
    const records = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_lost',
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 2, sessions: records }))

    const warns: string[] = []
    const out = await loadChannelSessions(dir, { info: () => {}, warn: (m) => warns.push(m), error: () => {} })

    expect(out).toHaveLength(1)
    expect(out[0]?.sessionFile).toBeUndefined()
    expect(out[0]?.lastInboundAt).toBe(0)
    expect(warns.some((w) => w.includes('ses_lost') && w.includes('no session file'))).toBe(true)
  })

  test('v2 migration is non-fatal when the sessions directory does not exist', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    // no sessions/ directory at all
    const records = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 2, sessions: records }))

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out).toHaveLength(1)
    expect(out[0]?.sessionFile).toBeUndefined()
    expect(out[0]?.lastInboundAt).toBe(0)
  })

  test('returns empty list and logs when file is corrupted JSON', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, '{not valid')
    const errors: string[] = []
    const out = await loadChannelSessions(dir, { info: () => {}, warn: () => {}, error: (m) => errors.push(m) })
    expect(out).toEqual([])
    expect(errors[0]).toContain('corrupted')
  })

  test('returns empty list and logs when file version is not supported', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 5, sessions: [] }))
    const warns: string[] = []
    const out = await loadChannelSessions(dir, { info: () => {}, warn: (m) => warns.push(m), error: () => {} })
    expect(out).toEqual([])
    expect(warns[0]).toContain('version 5 not supported')
  })
})

describe('saveChannelSessions', () => {
  test('persists records as a v4 file with stable structure', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        participants: [],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const raw = await readFile(channelsSessionsPath(dir), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(4)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].sessionId).toBe('ses_abc')
    expect(parsed.sessions[0].sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_abc.jsonl')
  })

  test('round-trips through load + save (with sessionFile)', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        participants: [{ authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 2, messageCount: 3 }],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toEqual(records)
  })

  test('round-trips through load + save (without sessionFile, e.g. unmigrated)', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        participants: [],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('ses_abc')
    expect(loaded[0]?.sessionFile).toBeUndefined()
  })

  test('dedupes by 4-tuple, last-write-wins', async () => {
    const dir = await tempDir()
    const a: ChannelSessionRecord = {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      sessionId: 'old',
      participants: [],
    }
    const b: ChannelSessionRecord = { ...a, sessionId: 'new' }
    await saveChannelSessions(dir, [a, b], silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('new')
  })
})

describe('findRecord', () => {
  test('matches on the full 4-tuple', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, sessionId: 's1', participants: [] },
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null, sessionId: 's2', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null })
    expect(found?.sessionId).toBe('s2')
  })

  test('treats missing thread as null', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, sessionId: 's1', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(found?.sessionId).toBe('s1')
  })
})
