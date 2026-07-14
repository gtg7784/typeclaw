import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitAutoFixes, type SpawnGit } from './commit'

describe('commitAutoFixes', () => {
  test('commits fixes without executing a planted hook', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-hookless-'))
    try {
      const run = async (args: string[]): Promise<void> => {
        const proc = Bun.spawn({
          cmd: ['git', ...args],
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(await proc.exited).toBe(0)
      }
      await run(['init', '-q', '-b', 'main'])
      await writeFile(join(cwd, 'config.json'), '{}\n')
      await run(['add', 'config.json'])
      await run(['commit', '-qm', 'initial'])
      await writeFile(join(cwd, 'config.json'), '{"fixed":true}\n')
      const marker = join(cwd, 'hook-ran')
      const hook = join(cwd, '.git', 'hooks', 'pre-commit')
      await writeFile(hook, `#!/bin/sh\nprintf hook > "${marker}"\n`)
      await chmod(hook, 0o755)

      const result = await commitAutoFixes({
        cwd,
        attempts: [{ ok: true, source: 'static', name: 'config', summary: 'fixed', changedPaths: ['config.json'] }],
      })

      expect(result.kind).toBe('committed')
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('threads gitstore args into doctor auto-fix git calls', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-commit-'))
    try {
      await mkdir(join(cwd, '.gitstore'))
      const calls: string[][] = []
      const prefix = ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd]
      const spawnGit: SpawnGit = async (args) => {
        calls.push(args)
        const command = args[prefix.length]
        if (command === 'status') return { exitCode: 0, stdout: ' M config.json\n', stderr: '' }
        if (command === 'rev-parse') return { exitCode: 0, stdout: 'abc123\n', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      const result = await commitAutoFixes({
        cwd,
        spawnGit,
        attempts: [{ ok: true, source: 'static', name: 'config', summary: '설정 수정', changedPaths: ['config.json'] }],
      })

      expect(result.kind).toBe('committed')
      expect(calls).toHaveLength(4)
      for (const args of calls) expect(args.slice(0, prefix.length)).toEqual(prefix)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
