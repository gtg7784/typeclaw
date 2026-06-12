import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reresolveLiveItem } from './open-item'
import type { SessionSummary } from './session-list'

let cwd: string
let sessionsDir: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'typeclaw-open-item-'))
  sessionsDir = join(cwd, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const ID = '019ee000-aaaa-7000-9000-00000000aaaa'

function metaLine(origin: unknown): string {
  return JSON.stringify({ type: 'custom', customType: 'typeclaw.session-meta', data: { origin }, timestamp: 0 })
}

function liveSummary(sessionId: string): SessionSummary {
  return {
    sessionId,
    sessionFile: '',
    basename: '',
    mtimeMs: 9000,
    origin: { kind: 'tui' },
    firstPrompt: null,
    live: true,
  }
}

const noWarn = (): void => {}

describe('reresolveLiveItem', () => {
  test('swaps a live-only row for the disk summary once the transcript has flushed', async () => {
    // given a live-only row whose session has since landed on disk
    await writeFile(join(sessionsDir, `2026-06-12T00-00-00-000Z_${ID}.jsonl`), metaLine({ kind: 'tui' }) + '\n')
    const item = { kind: 'session', summary: liveSummary(ID), writable: false } as const

    // when re-resolving before opening
    const resolved = await reresolveLiveItem(item, cwd, noWarn)

    // then it now carries the real file path and drops the live flag
    expect(resolved.kind).toBe('session')
    if (resolved.kind === 'logs') throw new Error('unreachable')
    expect(resolved.summary.sessionFile).not.toBe('')
    expect(resolved.summary.live).toBeUndefined()
  })

  test('keeps the live-only row when the session is still not on disk', async () => {
    // given a live-only row with no flushed transcript yet
    const item = { kind: 'session', summary: liveSummary(ID), writable: false } as const

    // when re-resolving
    const resolved = await reresolveLiveItem(item, cwd, noWarn)

    // then the original live summary is preserved so the live tail still works
    expect(resolved).toBe(item)
  })

  test('passes through non-live rows untouched', async () => {
    const disk: SessionSummary = {
      sessionId: ID,
      sessionFile: join(sessionsDir, `x_${ID}.jsonl`),
      basename: `x_${ID}.jsonl`,
      mtimeMs: 1000,
      origin: { kind: 'tui' },
      firstPrompt: 'hi',
    }
    const item = { kind: 'session', summary: disk, writable: false } as const
    expect(await reresolveLiveItem(item, cwd, noWarn)).toBe(item)
  })

  test('passes through the logs row untouched', async () => {
    const item = { kind: 'logs' } as const
    expect(await reresolveLiveItem(item, cwd, noWarn)).toBe(item)
  })
})
