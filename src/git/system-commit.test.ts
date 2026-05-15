import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitSystemFile, commitSystemFileSync } from './system-commit'

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

async function gitInit(cwd: string): Promise<void> {
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

describe('commitSystemFile (async)', () => {
  test('commits a dirty tracked file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-async-'))
    try {
      // given: a git repo with a tracked, then dirty, file
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), '{"a":1}\n')
      await runGit(dir, ['add', 'typeclaw.json'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'typeclaw.json'), '{"a":2}\n')

      // when
      await commitSystemFile(dir, 'typeclaw.json', 'update typeclaw.json')

      // then: HEAD subject matches and content is the new value
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('update typeclaw.json')
      expect(await runGit(dir, ['show', 'HEAD:typeclaw.json'])).toBe('{"a":2}')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips when file is clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-async-clean-'))
    try {
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), '{"a":1}\n')
      await runGit(dir, ['add', 'typeclaw.json'])
      await runGit(dir, ['commit', '-m', 'initial'])
      const head = await runGit(dir, ['rev-parse', 'HEAD'])

      await commitSystemFile(dir, 'typeclaw.json', 'noop')

      expect(await runGit(dir, ['rev-parse', 'HEAD'])).toBe(head)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips when folder is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-async-nogit-'))
    try {
      await writeFile(join(dir, 'typeclaw.json'), '{}\n')
      await commitSystemFile(dir, 'typeclaw.json', 'msg')
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('commitSystemFileSync', () => {
  test('commits a dirty tracked file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-sync-'))
    try {
      // given: a git repo with a tracked, then dirty, file
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), '{"a":1}\n')
      await runGit(dir, ['add', 'typeclaw.json'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'typeclaw.json'), '{"a":2}\n')

      // when: the sync variant is called (matches the persistMigratedConfig codepath)
      commitSystemFileSync(dir, 'typeclaw.json', 'update typeclaw.json')

      // then: HEAD subject matches and content is the new value
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('update typeclaw.json')
      expect(await runGit(dir, ['show', 'HEAD:typeclaw.json'])).toBe('{"a":2}')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips when file is clean (idempotency anchor — repeated migration reads stay no-op)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-sync-clean-'))
    try {
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), '{"a":1}\n')
      await runGit(dir, ['add', 'typeclaw.json'])
      await runGit(dir, ['commit', '-m', 'initial'])
      const head = await runGit(dir, ['rev-parse', 'HEAD'])

      commitSystemFileSync(dir, 'typeclaw.json', 'noop')

      expect(await runGit(dir, ['rev-parse', 'HEAD'])).toBe(head)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips when folder is not a git repo (matches async variant)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-sync-nogit-'))
    try {
      await writeFile(join(dir, 'typeclaw.json'), '{}\n')
      commitSystemFileSync(dir, 'typeclaw.json', 'msg')
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('only commits the named file, leaving other dirty files unstaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-commit-sync-scope-'))
    try {
      // given: two dirty tracked files
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), '{"a":1}\n')
      await writeFile(join(dir, 'AGENTS.md'), 'original\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'typeclaw.json'), '{"a":2}\n')
      await writeFile(join(dir, 'AGENTS.md'), 'user wip\n')

      // when: commit only typeclaw.json
      commitSystemFileSync(dir, 'typeclaw.json', 'migrate typeclaw.json')

      // then: only typeclaw.json is in the new commit; AGENTS.md is still dirty
      expect(await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('typeclaw.json')
      expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('user wip\n')
      expect(await runGit(dir, ['show', 'HEAD:AGENTS.md'])).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
