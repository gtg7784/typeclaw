import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBunInstall, runBunUpdate } from './run-bun-install'

describe('runBunInstall', () => {
  test('times out a hung install process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunInstall(cwd, { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun install timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('runBunUpdate', () => {
  test('times out a hung update process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-update-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunUpdate(cwd, 'typeclaw', { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun update typeclaw timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
