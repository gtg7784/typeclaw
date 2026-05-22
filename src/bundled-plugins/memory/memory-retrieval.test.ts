import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'

import { checkNonWorkspaceWriteGuard } from '../guard/policies/non-workspace-write'
import {
  createMemoryRetrievalSubagent,
  isMemoryRetrievalPayload,
  MEMORY_RETRIEVAL_SYSTEM_PROMPT,
  memoryRetrievalSubagent,
  type MemoryRetrievalLogger,
  type MemoryRetrievalPayload,
} from './memory-retrieval'

const silentLogger: MemoryRetrievalLogger = { info: () => {}, warn: () => {}, error: () => {} }
const silentSubagent = createMemoryRetrievalSubagent({ logger: silentLogger })

describe('memory-retrieval payload schema', () => {
  test('accepts valid payloads and rejects bad input', () => {
    expect(
      isMemoryRetrievalPayload({
        parentSessionId: 's1',
        agentDir: '/agent',
        recentPrompt: 'tell me about deploys',
        cacheFilePath: 'memory/.retrieval-cache/s1.md',
        origin: { kind: 'tui', sessionId: 's1' },
      }),
    ).toBe(true)

    expect(isMemoryRetrievalPayload({})).toBe(false)
    expect(
      isMemoryRetrievalPayload({
        parentSessionId: 's1',
        agentDir: '/agent',
        recentPrompt: 'tell me about deploys',
      }),
    ).toBe(false)
  })
})

describe('memoryRetrievalSubagent', () => {
  test('tool surface includes write and memory_search', () => {
    expect(memoryRetrievalSubagent.tools?.map((tool) => tool.__builtinTool)).toEqual(['read', 'write', 'ls'])
    expect(memoryRetrievalSubagent.customTools).toContainEqual(
      expect.objectContaining({ description: expect.stringContaining("Search the agent's long-term memory") }),
    )
  })

  test('inFlightKey keys on parentSessionId', () => {
    expect(
      memoryRetrievalSubagent.inFlightKey!({
        parentSessionId: 's1',
        agentDir: '/agent/a',
        recentPrompt: 'x',
        cacheFilePath: 'memory/.retrieval-cache/s1.md',
      }),
    ).toBe('s1')
  })

  test('system prompt mentions cacheFilePath and memory_search', () => {
    expect(MEMORY_RETRIEVAL_SYSTEM_PROMPT).toContain('cacheFilePath')
    expect(MEMORY_RETRIEVAL_SYSTEM_PROMPT).toContain('memory_search')
  })

  test('handler runs and the subagent writes to the cache file path', async () => {
    const agentDir = await makeAgentDir()
    const payload: MemoryRetrievalPayload = {
      parentSessionId: 's1',
      agentDir,
      recentPrompt: 'What do we know about deploys?',
      cacheFilePath: 'memory/.retrieval-cache/s1.md',
    }
    const prompts: string[] = []
    const runSession: RunSession = async (override) => {
      prompts.push(override?.userPrompt ?? '')
      const cachePath = path.join(agentDir, payload.cacheFilePath)
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, 'Deploy summary from relevant memory shards.\n')
    }

    await silentSubagent.handler!(context(agentDir, payload), runSession)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(payload.recentPrompt)
    expect(await Bun.file(path.join(agentDir, payload.cacheFilePath)).text()).toContain('Deploy summary')
  })

  test('guard permits only the retrieval cache file, not other memory paths', async () => {
    const agentDir = await makeAgentDir()
    const origin = { kind: 'subagent' as const, subagent: 'memory-retrieval', parentSessionId: 's1' }

    const cache = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'memory/.retrieval-cache/s1.md', content: 'summary' },
      agentDir,
      origin,
    })
    const outside = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'MEMORY.md.synthesized', content: 'oops' },
      agentDir,
      origin,
    })

    expect(cache).toBeUndefined()
    expect(outside?.block).toBe(true)
  })

  test('an out-of-bounds write attempt leaves only the cache file changed', async () => {
    const agentDir = await makeAgentDir()
    const before = await listFiles(agentDir)
    const payload: MemoryRetrievalPayload = {
      parentSessionId: 's1',
      agentDir,
      recentPrompt: 'What do we know about deploys?',
      cacheFilePath: 'memory/.retrieval-cache/s1.md',
    }
    const origin = { kind: 'subagent' as const, subagent: 'memory-retrieval', parentSessionId: 's1' }
    const runSession: RunSession = async () => {
      const outside = await checkNonWorkspaceWriteGuard({
        tool: 'write',
        args: { path: 'MEMORY.md.synthesized', content: 'oops' },
        agentDir,
        origin,
      })
      if (outside === undefined) await writeFile(path.join(agentDir, 'MEMORY.md.synthesized'), 'oops')

      const cache = await checkNonWorkspaceWriteGuard({
        tool: 'write',
        args: { path: payload.cacheFilePath, content: 'summary' },
        agentDir,
        origin,
      })
      if (cache !== undefined) throw new Error(cache.reason)
      const cachePath = path.join(agentDir, payload.cacheFilePath)
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, 'summary')
    }

    await silentSubagent.handler!(context(agentDir, payload), runSession)

    expect(existsSync(path.join(agentDir, 'MEMORY.md.synthesized'))).toBe(false)
    const after = await listFiles(agentDir)
    expect(after.filter((file) => !before.includes(file))).toEqual(['memory/.retrieval-cache/s1.md'])
  })
})

async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-memory-retrieval-'))
  await mkdir(path.join(agentDir, 'workspace'), { recursive: true })
  await mkdir(path.join(agentDir, 'memory', 'topics'), { recursive: true })
  await writeFile(path.join(agentDir, 'memory', 'topics', 'deploys.md'), '# Deploys\n')
  return agentDir
}

function context(agentDir: string, payload: MemoryRetrievalPayload): SubagentContext<MemoryRetrievalPayload> {
  return { userPrompt: '', agentDir, payload }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, root, out)
  return out.sort()
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(root, absolute, out)
    } else {
      out.push(path.relative(root, absolute))
    }
  }
}
