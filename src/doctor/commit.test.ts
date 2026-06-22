import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitAutoFixes, type SpawnGit } from './commit'

describe('commitAutoFixes', () => {
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
