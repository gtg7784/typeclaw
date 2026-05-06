import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverAgents } from './discover'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-discover-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeAgent(parent: string, name: string): Promise<string> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), '{}\n')
  return dir
}

describe('discoverAgents', () => {
  test('returns immediate subdirs that contain typeclaw.json', async () => {
    await makeAgent(root, 'coder')
    await makeAgent(root, 'planner')

    const agents = discoverAgents(root)

    expect(agents.map((a) => a.name)).toEqual(['coder', 'planner'])
    expect(agents[0]?.cwd).toBe(join(root, 'coder'))
    expect(agents[0]?.containerName).toBe('coder')
  })

  test('ignores subdirs without typeclaw.json', async () => {
    await makeAgent(root, 'coder')
    await mkdir(join(root, 'not-an-agent'))

    expect(discoverAgents(root).map((a) => a.name)).toEqual(['coder'])
  })

  test('skips dot-prefixed directories', async () => {
    await makeAgent(root, 'coder')
    // A `.git` dir at the compose root would otherwise pass if it ever held a
    // typeclaw.json — keep the filter explicit so future weirdness can't leak in.
    await makeAgent(root, '.hidden-agent')

    expect(discoverAgents(root).map((a) => a.name)).toEqual(['coder'])
  })

  test('ignores files at the compose root, even if named typeclaw.json', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}\n')
    await makeAgent(root, 'coder')

    expect(discoverAgents(root).map((a) => a.name)).toEqual(['coder'])
  })

  test('does not recurse beyond one depth', async () => {
    await makeAgent(root, 'team')
    // Nested agent — should not be discovered. `team/` itself is the agent
    // because it has typeclaw.json; the nested one is invisible to compose.
    await makeAgent(join(root, 'team'), 'nested')

    expect(discoverAgents(root).map((a) => a.name)).toEqual(['team'])
  })

  test('returns empty array when root has no agent subdirs', async () => {
    expect(discoverAgents(root)).toEqual([])
  })

  test('returns empty array when root does not exist', async () => {
    expect(discoverAgents(join(root, 'does-not-exist'))).toEqual([])
  })

  test('sorts agents alphabetically for deterministic output', async () => {
    await makeAgent(root, 'zebra')
    await makeAgent(root, 'alpha')
    await makeAgent(root, 'mango')

    expect(discoverAgents(root).map((a) => a.name)).toEqual(['alpha', 'mango', 'zebra'])
  })
})
