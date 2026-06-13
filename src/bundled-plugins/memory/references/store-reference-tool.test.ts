import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { referenceFilePath, streamsDir } from '../paths'
import { readEvents } from '../stream-io'
import { parseReference } from './frontmatter'
import { storeReferenceTool } from './store-reference-tool'

describe('storeReferenceTool', () => {
  test('stores a verbatim multi-line SQL reference and returns its slug', async () => {
    const agentDir = await makeAgentDir()
    const body = ['SELECT *', 'FROM users', 'WHERE id = 1;'].join('\n')

    const result = await storeReferenceTool.execute(
      { title: 'User lookup query', body, origin: 'episode', tags: ['sql'] },
      ctx(agentDir),
    )

    expect(textContent(result)).toBe('Stored reference as user-lookup-query')
    const path = referenceFilePath(agentDir, 'user-lookup-query')
    expect(existsSync(path)).toBe(true)
    const { frontmatter, body: storedBody } = parseReference(await readFile(path, 'utf8'))
    expect(storedBody).toBe(body)
    expect(frontmatter).toMatchObject({
      title: 'User lookup query',
      origin: 'episode',
      accessCount: 0,
      pinned: false,
      demoted: false,
      tags: ['sql'],
    })
    expect(frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(frontmatter.lastAccessed).toBe(frontmatter.created)

    await cleanup(agentDir)
  })

  test('does not write a fragment event containing the verbatim SQL body', async () => {
    const agentDir = await makeAgentDir()
    const body = 'SELECT * FROM users WHERE id = 1'

    await storeReferenceTool.execute({ title: 'Guard query', body, origin: 'episode', tags: [] }, ctx(agentDir))

    const streamNames = await listStreams(agentDir)
    const eventsByDay = await Promise.all(streamNames.map((name) => readEvents(join(streamsDir(agentDir), name))))
    const fragmentBodies = eventsByDay
      .flat()
      .filter((event) => event.type === 'fragment')
      .map((event) => event.body)
    expect(fragmentBodies).not.toContain(body)

    await cleanup(agentDir)
  })

  test('deduplicates slug collisions for matching titles', async () => {
    const agentDir = await makeAgentDir()

    await storeReferenceTool.execute({ title: 'Same title', body: 'first', origin: 'episode', tags: [] }, ctx(agentDir))
    const result = await storeReferenceTool.execute(
      { title: 'Same title', body: 'second', origin: 'episode', tags: [] },
      ctx(agentDir),
    )

    expect(textContent(result)).toBe('Stored reference as same-title-2')
    expect(existsSync(referenceFilePath(agentDir, 'same-title'))).toBe(true)
    expect(existsSync(referenceFilePath(agentDir, 'same-title-2'))).toBe(true)

    await cleanup(agentDir)
  })
})

function ctx(agentDir: string): ToolContext {
  return {
    signal: undefined,
    sessionId: 'test',
    agentDir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

function textContent(result: { content: { type: string; text?: string }[] }): string | undefined {
  return result.content.find((part) => part.type === 'text')?.text
}

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memory-reference-tool-'))
}

async function listStreams(agentDir: string): Promise<string[]> {
  try {
    return await readdir(streamsDir(agentDir))
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }
}

async function cleanup(agentDir: string): Promise<void> {
  await rm(agentDir, { recursive: true, force: true })
}
