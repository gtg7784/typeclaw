import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listViewerItems } from './item-list'

let agentDir: string
let sessionsDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-item-list-'))
  sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

const ID_A = '019ee000-aaaa-7000-9000-00000000aaaa'
const ID_B = '019ee000-bbbb-7000-9000-00000000bbbb'
const ID_C = '019ee000-cccc-7000-9000-00000000cccc'

function metaLine(origin: unknown): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'typeclaw.session-meta',
    data: { origin },
    timestamp: 1_000_000,
  })
}

async function seed(basename: string, origin: unknown, mtimeSeconds: number): Promise<void> {
  const path = join(sessionsDir, basename)
  await writeFile(path, metaLine(origin) + '\n')
  await utimes(path, mtimeSeconds, mtimeSeconds)
}

describe('listViewerItems', () => {
  test('marks the most-recent tui-origin session as the single writable item when container is up', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 3000)
    await seed(`c_${ID_C}.jsonl`, { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, 2000)

    const { items, writableSessionId } = await listViewerItems({ sessionsDir, containerRunning: true })

    expect(writableSessionId).toBe(ID_B)
    const writable = items.filter((i) => i.kind === 'tui')
    expect(writable).toHaveLength(1)
    expect(writable[0]).toMatchObject({ kind: 'tui', writable: true })
    const cronItem = items.find((i) => i.kind === 'session' && i.summary.sessionId === ID_C)
    expect(cronItem).toBeDefined()
  })

  test('all sessions are read-only when the container is down', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 2000)

    const { items, writableSessionId } = await listViewerItems({ sessionsDir, containerRunning: false })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'session')).toHaveLength(2)
  })

  test('allowWritable:false suppresses the writable row even with the container up (detach handoff)', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 3000)

    const { items, writableSessionId } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      allowWritable: false,
    })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'session')).toHaveLength(2)
  })

  test('appends a logs row by default, suppressible via includeLogs:false', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)

    const withLogs = await listViewerItems({ sessionsDir, containerRunning: true })
    expect(withLogs.items.at(-1)).toEqual({ kind: 'logs' })

    const withoutLogs = await listViewerItems({ sessionsDir, containerRunning: true, includeLogs: false })
    expect(withoutLogs.items.some((i) => i.kind === 'logs')).toBe(false)
  })

  test('no writable item when container is up but no tui-origin session exists', async () => {
    await seed(`c_${ID_C}.jsonl`, { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, 2000)

    const { writableSessionId, items } = await listViewerItems({ sessionsDir, containerRunning: true })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
  })
})
