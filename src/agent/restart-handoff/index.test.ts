import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireRestartHandoffLock,
  consumeRestartHandoff,
  peekRestartHandoff,
  RESTART_HANDOFF_TTL_MS,
  type RestartHandoff,
  restartHandoffPath,
  writeRestartHandoff,
} from './index'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-restart-handoff-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function tuiHandoff(overrides: Partial<RestartHandoff> = {}): RestartHandoff {
  return {
    schemaVersion: 2,
    restartedAt: '2026-05-26T10:00:00.000Z',
    originatingSessionId: 'ses-abc',
    originatingSessionFile: 'ses-abc.jsonl',
    origin: { kind: 'tui' },
    ...overrides,
  }
}

function channelHandoff(overrides: Partial<RestartHandoff> = {}): RestartHandoff {
  return {
    schemaVersion: 2,
    restartedAt: '2026-05-26T10:00:00.000Z',
    originatingSessionId: 'ses-chan',
    originatingSessionFile: 'ses-chan.jsonl',
    origin: { kind: 'channel', key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null } },
    ...overrides,
  }
}

describe('writeRestartHandoff', () => {
  test('persists handoff at .typeclaw/restart-pending.json', async () => {
    await writeRestartHandoff(agentDir, tuiHandoff())

    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')
    expect(JSON.parse(raw)).toEqual(tuiHandoff())
  })

  test('round-trips a channel-origin handoff with its channel key', async () => {
    await writeRestartHandoff(agentDir, channelHandoff())

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result).toEqual(channelHandoff())
  })

  test('round-trips a triggeringAuthorId so the resumed session re-seeds the requester', async () => {
    await writeRestartHandoff(agentDir, channelHandoff({ triggeringAuthorId: 'U_OWNER' }))

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result?.triggeringAuthorId).toBe('U_OWNER')
  })

  test('round-trips interruptedSubagents so the resumed session can name the lost work', async () => {
    await writeRestartHandoff(agentDir, channelHandoff({ interruptedSubagents: ['researcher', 'scout'] }))

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result?.interruptedSubagents).toEqual(['researcher', 'scout'])
  })

  test('omits interruptedSubagents from the persisted JSON when absent', async () => {
    await writeRestartHandoff(agentDir, channelHandoff())

    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')

    expect(Object.hasOwn(JSON.parse(raw), 'interruptedSubagents')).toBe(false)
  })

  test('creates the .typeclaw/ directory on demand', async () => {
    expect(existsSync(join(agentDir, '.typeclaw'))).toBe(false)
    await writeRestartHandoff(agentDir, tuiHandoff())
    expect(existsSync(join(agentDir, '.typeclaw'))).toBe(true)
  })

  test('returns true when the handoff is written', async () => {
    expect(await writeRestartHandoff(agentDir, tuiHandoff())).toBe(true)
  })

  test('returns false (does not throw) when the write fails (best-effort)', async () => {
    // given: a path under a file, so mkdir/write cannot succeed
    const notADir = join(agentDir, 'blocker')
    await writeFile(notADir, 'x', 'utf8')

    expect(await writeRestartHandoff(join(notADir, 'nested'), tuiHandoff())).toBe(false)
  })

  test('overwrites a prior handoff file', async () => {
    await writeRestartHandoff(agentDir, tuiHandoff({ originatingSessionId: 'ses-first' }))
    await writeRestartHandoff(
      agentDir,
      tuiHandoff({ originatingSessionId: 'ses-second', restartedAt: '2026-05-26T10:00:01.000Z' }),
    )

    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')
    expect(JSON.parse(raw).originatingSessionId).toBe('ses-second')
  })
})

describe('acquireRestartHandoffLock', () => {
  test('serializes holders: a second acquire waits until the first releases', async () => {
    // given: one holder of the lock for this agentDir
    const release1 = await acquireRestartHandoffLock(agentDir)
    let secondAcquired = false
    const second = acquireRestartHandoffLock(agentDir).then((r) => {
      secondAcquired = true
      return r
    })

    // when: we let microtasks flush WITHOUT releasing the first
    await Promise.resolve()
    await Promise.resolve()

    // then: the second is still blocked
    expect(secondAcquired).toBe(false)

    // when: the first releases
    release1()
    const release2 = await second

    // then: the second acquires
    expect(secondAcquired).toBe(true)
    release2()
  })

  test('distinct agent dirs do not contend', async () => {
    const other = await mkdtemp(join(tmpdir(), 'typeclaw-handoff-lock-'))
    try {
      const releaseA = await acquireRestartHandoffLock(agentDir)
      // a different dir's lock is immediately available even while agentDir is held
      const releaseB = await acquireRestartHandoffLock(other)
      releaseA()
      releaseB()
      expect(true).toBe(true)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  test('double release is a no-op (does not free a later holder early)', async () => {
    const release1 = await acquireRestartHandoffLock(agentDir)
    release1()
    release1() // second call must not corrupt the queue
    const release2 = await acquireRestartHandoffLock(agentDir)
    release2()
    expect(true).toBe(true)
  })
})

describe('peekRestartHandoff', () => {
  test('returns null when no handoff file exists', async () => {
    expect(await peekRestartHandoff(agentDir)).toBeNull()
  })

  test('reads the handoff WITHOUT deleting it or applying the TTL', async () => {
    // given: a handoff far older than the TTL — consume would drop it, peek must not
    await writeRestartHandoff(
      agentDir,
      channelHandoff({ restartedAt: new Date(Date.now() - (RESTART_HANDOFF_TTL_MS + 60_000)).toISOString() }),
    )

    const peeked = await peekRestartHandoff(agentDir)

    expect(peeked?.origin.kind).toBe('channel')
    expect(existsSync(restartHandoffPath(agentDir))).toBe(true)
  })

  test('returns null on malformed JSON without deleting the file', async () => {
    await Bun.write(restartHandoffPath(agentDir), '{ not json')

    expect(await peekRestartHandoff(agentDir)).toBeNull()
    expect(existsSync(restartHandoffPath(agentDir))).toBe(true)
  })
})

describe('consumeRestartHandoff', () => {
  test('returns null when no handoff file exists', async () => {
    const result = await consumeRestartHandoff(agentDir)
    expect(result).toBeNull()
  })

  test('returns the handoff and deletes the file on success', async () => {
    await writeRestartHandoff(agentDir, tuiHandoff())

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toEqual(tuiHandoff())
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('reads a v1 handoff forward as a tui origin', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(
      path,
      JSON.stringify({
        schemaVersion: 1,
        restartedAt: '2026-05-26T10:00:00.000Z',
        originatingSessionId: 'ses-legacy',
        originatingSessionFile: 'ses-legacy.jsonl',
      }),
    )

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result).toEqual({
      schemaVersion: 2,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-legacy',
      originatingSessionFile: 'ses-legacy.jsonl',
      origin: { kind: 'tui' },
    })
  })

  test('returns null AND deletes the file when older than ttlMs', async () => {
    await writeRestartHandoff(agentDir, tuiHandoff())

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:01:10.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('uses RESTART_HANDOFF_TTL_MS (60s) as the default TTL', async () => {
    await writeRestartHandoff(
      agentDir,
      tuiHandoff({ restartedAt: new Date(Date.now() - (RESTART_HANDOFF_TTL_MS + 5_000)).toISOString() }),
    )

    const result = await consumeRestartHandoff(agentDir)

    expect(result).toBeNull()
  })

  test('returns null AND deletes the file when JSON is malformed', async () => {
    const path = restartHandoffPath(agentDir)
    await writeFile(path.replace(/[^/]+$/, ''), '', 'utf8').catch(() => undefined)
    await Bun.write(path, '{ not valid json')

    const result = await consumeRestartHandoff(agentDir)

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('returns null when schemaVersion is unsupported', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify({ ...channelHandoff(), schemaVersion: 99 }))

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('ignores a non-string triggeringAuthorId instead of rejecting the handoff', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify({ ...channelHandoff(), triggeringAuthorId: 42 }))

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result?.origin.kind).toBe('channel')
    expect(result?.triggeringAuthorId).toBeUndefined()
  })

  test('ignores a non-array interruptedSubagents instead of rejecting the handoff', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify({ ...channelHandoff(), interruptedSubagents: 'researcher' }))

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result?.origin.kind).toBe('channel')
    expect(result?.interruptedSubagents).toBeUndefined()
  })

  test('drops non-string entries and an empty interruptedSubagents array', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify({ ...channelHandoff(), interruptedSubagents: ['researcher', 7, '', 'scout'] }))

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result?.interruptedSubagents).toEqual(['researcher', 'scout'])
  })

  test('a >60s-old handoff carrying interruptedSubagents is dropped (stop→idle→start stays quiet)', async () => {
    await writeRestartHandoff(
      agentDir,
      channelHandoff({
        restartedAt: new Date(Date.now() - (RESTART_HANDOFF_TTL_MS + 60_000)).toISOString(),
        interruptedSubagents: ['researcher'],
      }),
    )

    const result = await consumeRestartHandoff(agentDir, { accept: (h) => h.origin.kind === 'channel' })

    expect(result).toBeNull()
  })

  test('returns null when a v2 channel handoff is missing its key', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(
      path,
      JSON.stringify({
        schemaVersion: 2,
        restartedAt: '2026-05-26T10:00:00.000Z',
        originatingSessionId: 'ses-chan',
        originatingSessionFile: 'ses-chan.jsonl',
        origin: { kind: 'channel' },
      }),
    )

    const result = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(result).toBeNull()
  })

  test('returns null when originatingSessionId is empty', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify(tuiHandoff({ originatingSessionId: '' })))

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
  })

  test('returns null when restartedAt is not parseable as a date', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(path, JSON.stringify(tuiHandoff({ restartedAt: 'not-a-date' })))

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('returns the handoff exactly once (second consume sees no file)', async () => {
    await writeRestartHandoff(agentDir, tuiHandoff())

    const first = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })
    const second = await consumeRestartHandoff(agentDir, { now: Date.parse('2026-05-26T10:00:30.000Z') })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  describe('accept predicate (kind-aware claiming)', () => {
    test('claims a handoff the predicate accepts and deletes the file', async () => {
      await writeRestartHandoff(agentDir, tuiHandoff())

      const result = await consumeRestartHandoff(agentDir, {
        now: Date.parse('2026-05-26T10:00:30.000Z'),
        accept: (h) => h.origin.kind === 'tui',
      })

      expect(result).toEqual(tuiHandoff())
      expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
    })

    test('rejects a handoff the predicate refuses and LEAVES the file untouched', async () => {
      await writeRestartHandoff(agentDir, channelHandoff())

      const result = await consumeRestartHandoff(agentDir, {
        now: Date.parse('2026-05-26T10:00:30.000Z'),
        accept: (h) => h.origin.kind === 'tui',
      })

      expect(result).toBeNull()
      expect(existsSync(restartHandoffPath(agentDir))).toBe(true)
    })

    test('an unclaimed channel handoff is still claimable by the channel predicate', async () => {
      await writeRestartHandoff(agentDir, channelHandoff())

      const tuiClaim = await consumeRestartHandoff(agentDir, {
        now: Date.parse('2026-05-26T10:00:30.000Z'),
        accept: (h) => h.origin.kind === 'tui',
      })
      const channelClaim = await consumeRestartHandoff(agentDir, {
        now: Date.parse('2026-05-26T10:00:30.000Z'),
        accept: (h) => h.origin.kind === 'channel',
      })

      expect(tuiClaim).toBeNull()
      expect(channelClaim).toEqual(channelHandoff())
      expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
    })
  })
})
