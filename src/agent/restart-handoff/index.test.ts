import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { consumeRestartHandoff, RESTART_HANDOFF_TTL_MS, restartHandoffPath, writeRestartHandoff } from './index'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-restart-handoff-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('writeRestartHandoff', () => {
  test('persists handoff at .typeclaw/restart-pending.json', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })

    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })
  })

  test('creates the .typeclaw/ directory on demand', async () => {
    expect(existsSync(join(agentDir, '.typeclaw'))).toBe(false)
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })
    expect(existsSync(join(agentDir, '.typeclaw'))).toBe(true)
  })

  test('does not throw when the agent directory does not exist (best-effort)', async () => {
    await expect(
      writeRestartHandoff('/nonexistent/path/that/does/not/exist', {
        schemaVersion: 1,
        restartedAt: '2026-05-26T10:00:00.000Z',
        originatingSessionId: 'ses-abc',
        originatingSessionFile: 'ses-abc.jsonl',
      }),
    ).resolves.toBeUndefined()
  })

  test('overwrites a prior handoff file', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-first',
      originatingSessionFile: 'ses-first.jsonl',
    })
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:01.000Z',
      originatingSessionId: 'ses-second',
      originatingSessionFile: 'ses-second.jsonl',
    })

    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')
    expect(JSON.parse(raw).originatingSessionId).toBe('ses-second')
  })
})

describe('consumeRestartHandoff', () => {
  test('returns null when no handoff file exists', async () => {
    const result = await consumeRestartHandoff(agentDir)
    expect(result).toBeNull()
  })

  test('returns the handoff and deletes the file on success', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toEqual({
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('returns null AND deletes the file when older than ttlMs', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:01:10.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('uses RESTART_HANDOFF_TTL_MS (60s) as the default TTL', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: new Date(Date.now() - (RESTART_HANDOFF_TTL_MS + 5_000)).toISOString(),
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })

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

  test('returns null when schemaVersion is missing or wrong', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(
      path,
      JSON.stringify({
        schemaVersion: 99,
        restartedAt: '2026-05-26T10:00:00.000Z',
        originatingSessionId: 'ses-abc',
        originatingSessionFile: 'ses-abc.jsonl',
      }),
    )

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('returns null when originatingSessionId is empty', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(
      path,
      JSON.stringify({
        schemaVersion: 1,
        restartedAt: '2026-05-26T10:00:00.000Z',
        originatingSessionId: '',
        originatingSessionFile: 'ses-abc.jsonl',
      }),
    )

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
  })

  test('returns null when restartedAt is not parseable as a date', async () => {
    const path = restartHandoffPath(agentDir)
    await Bun.write(
      path,
      JSON.stringify({
        schemaVersion: 1,
        restartedAt: 'not-a-date',
        originatingSessionId: 'ses-abc',
        originatingSessionFile: 'ses-abc.jsonl',
      }),
    )

    const result = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('returns the handoff exactly once (second consume sees no file)', async () => {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: '2026-05-26T10:00:00.000Z',
      originatingSessionId: 'ses-abc',
      originatingSessionFile: 'ses-abc.jsonl',
    })

    const first = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })
    const second = await consumeRestartHandoff(agentDir, {
      now: Date.parse('2026-05-26T10:00:30.000Z'),
    })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })
})
