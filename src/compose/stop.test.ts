import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeStop, type ComposeStopEvent } from './stop'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-stop-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

// Malformed JSON so validateConfig short-circuits before real Docker calls;
// see src/compose/start.test.ts for the full rationale.
async function makeAgent(parent: string, name: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), 'this is not json\n')
}

describe('composeStop events', () => {
  test('emits agent-start then agent-done for every discovered agent', async () => {
    await makeAgent(root, 'alpha')
    await makeAgent(root, 'bravo')

    const events: ComposeStopEvent[] = []
    const { results } = await composeStop({
      rootCwd: root,
      onProgress: (event) => events.push(event),
    })

    expect(results).toHaveLength(2)

    const starts = events.filter((e) => e.kind === 'agent-start').map((e) => e.name)
    const dones = events.filter((e) => e.kind === 'agent-done').map((e) => e.name)
    expect(new Set(starts)).toEqual(new Set(['alpha', 'bravo']))
    expect(new Set(dones)).toEqual(new Set(['alpha', 'bravo']))
  })

  test('agent-start precedes agent-done for each agent name', async () => {
    await makeAgent(root, 'solo')

    const events: ComposeStopEvent[] = []
    await composeStop({
      rootCwd: root,
      onProgress: (event) => events.push(event),
    })

    const startIdx = events.findIndex((e) => e.kind === 'agent-start' && e.name === 'solo')
    const doneIdx = events.findIndex((e) => e.kind === 'agent-done' && e.name === 'solo')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(doneIdx).toBeGreaterThan(startIdx)
  })

  test('agent-done carries the same AgentResult as the returned results', async () => {
    await makeAgent(root, 'alpha')

    const events: ComposeStopEvent[] = []
    const { results } = await composeStop({
      rootCwd: root,
      onProgress: (event) => events.push(event),
    })

    const done = events.find((e) => e.kind === 'agent-done')
    expect(done).toBeDefined()
    if (done?.kind !== 'agent-done') throw new Error('unreachable')
    expect(done.result).toEqual(results[0]!)
  })

  test('emits no events when no agents are discovered', async () => {
    const events: ComposeStopEvent[] = []
    const { agents, results } = await composeStop({
      rootCwd: root,
      onProgress: (event) => events.push(event),
    })

    expect(agents).toEqual([])
    expect(results).toEqual([])
    expect(events).toEqual([])
  })

  test('runs without onProgress', async () => {
    await makeAgent(root, 'alpha')
    const { results } = await composeStop({ rootCwd: root })
    expect(results).toHaveLength(1)
  })
})
