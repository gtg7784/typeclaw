import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

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

const silentLogger = { warn: () => {}, error: () => {} }

describe('loadChannelSessions', () => {
  test('returns empty list when file is missing', async () => {
    const dir = await tempDir()
    const out = await loadChannelSessions(dir, silentLogger)
    expect(out).toEqual([])
  })

  test('returns parsed sessions for a v2 file', async () => {
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
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 2, sessions: records }))
    const out = await loadChannelSessions(dir, silentLogger)
    expect(out).toHaveLength(1)
    expect(out[0]?.sessionId).toBe('ses_abc')
  })

  test('returns empty list and logs when file is corrupted JSON', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, '{not valid')
    const errors: string[] = []
    const out = await loadChannelSessions(dir, { warn: () => {}, error: (m) => errors.push(m) })
    expect(out).toEqual([])
    expect(errors[0]).toContain('corrupted')
  })

  test('returns empty list and logs when file is not v2', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, sessions: [] }))
    const warns: string[] = []
    const out = await loadChannelSessions(dir, { warn: (m) => warns.push(m), error: () => {} })
    expect(out).toEqual([])
    expect(warns[0]).toContain('not version 2')
  })
})

describe('saveChannelSessions', () => {
  test('persists records as a v2 file with stable structure', async () => {
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
    const raw = await readFile(channelsSessionsPath(dir), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(2)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].sessionId).toBe('ses_abc')
  })

  test('round-trips through load + save', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        participants: [
          { authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 2, messageCount: 3 },
        ],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toEqual(records)
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
