import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveOriginPushUrl } from './index'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
} as const

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  })
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-push-url-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveOriginPushUrl', () => {
  test('standalone .git agent: returns its own origin push url', async () => {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/standalone.git'])

    expect(await resolveOriginPushUrl(root)).toBe('https://github.com/acme/standalone.git')
  })

  test('relocated .gitstore child reads the AGENT origin, not the parent monorepo origin', async () => {
    // given: a parent monorepo whose own origin differs from the child agent's
    await git(root, ['init', '-b', 'main'])
    await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/fleet.git'])

    const agentDir = join(root, 'agents', 'alice')
    await mkdir(agentDir, { recursive: true })
    await git(agentDir, ['init', '-b', 'main'])
    await git(agentDir, ['remote', 'add', 'origin', 'https://github.com/acme/alice.git'])

    // when: the agent's git db is relocated out of its working tree to .gitstore
    await rename(join(agentDir, '.git'), join(agentDir, '.gitstore'))

    // then: resolution threads --git-dir/--work-tree and reads alice's origin,
    // never walking up to the parent fleet repo
    expect(await resolveOriginPushUrl(agentDir)).toBe('https://github.com/acme/alice.git')
  })

  test('no repo at all (neither .git nor .gitstore): returns null', async () => {
    expect(await resolveOriginPushUrl(root)).toBeNull()
  })
})
