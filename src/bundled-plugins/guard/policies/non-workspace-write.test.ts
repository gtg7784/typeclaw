import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { checkNonWorkspaceWriteGuard } from './non-workspace-write'

describe('non-workspace-write guard policy', () => {
  test('allows memory-retrieval subagent writes to its retrieval cache file', async () => {
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'memory/.retrieval-cache/s1.md', content: 'summary' },
      agentDir,
      origin: { kind: 'subagent', subagent: 'memory-retrieval', parentSessionId: 's1' },
    })

    expect(result).toBeUndefined()
  })

  test('blocks main-agent writes to the retrieval cache file', async () => {
    const agentDir = await makeAgentDir()

    const result = await checkNonWorkspaceWriteGuard({
      tool: 'write',
      args: { path: 'memory/.retrieval-cache/s1.md', content: 'summary' },
      agentDir,
      origin: { kind: 'tui', sessionId: 's1' },
    })

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('nonWorkspaceWrite'),
    })
  })
})

async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-non-workspace-write-'))
  await mkdir(path.join(agentDir, 'workspace'), { recursive: true })
  return agentDir
}
