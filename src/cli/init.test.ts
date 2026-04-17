import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configSchema } from '@/config/config'

import { isDirectoryNonEmpty, scaffold, writeSecrets } from './init'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-init-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('isDirectoryNonEmpty', () => {
  test('returns false for empty directory', () => {
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns false when directory only contains dotfiles', async () => {
    await writeFile(join(root, '.hidden'), '')
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns true when directory contains a regular file', async () => {
    await writeFile(join(root, 'file.txt'), '')
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns true when directory contains a regular subdirectory', async () => {
    await mkdir(join(root, 'sub'))
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns false for a nonexistent directory', () => {
    expect(isDirectoryNonEmpty(join(root, 'does-not-exist'))).toBe(false)
  })
})

describe('scaffold', () => {
  test('creates expected directories', async () => {
    await scaffold(root, { name: 'coder' })

    for (const dir of ['workspace', 'sessions', 'memory', 'skills', '.agents/skills']) {
      const path = join(root, dir)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    }
  })

  test('writes config.json with the given agent name', async () => {
    await scaffold(root, { name: 'coder' })

    const raw = await readFile(join(root, 'config.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      name: 'coder',
      version: 1,
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p5-turbo',
    })
  })

  test('writes config.json that passes configSchema validation', async () => {
    await scaffold(root, { name: 'coder' })

    const raw = await readFile(join(root, 'config.json'), 'utf8')
    expect(() => configSchema.parse(JSON.parse(raw))).not.toThrow()
  })

  test('creates empty markdown files', async () => {
    await scaffold(root, { name: 'coder' })

    for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
      expect(await readFile(join(root, file), 'utf8')).toBe('')
    }
  })

  test('writes .gitignore with secret and workspace entries', async () => {
    await scaffold(root, { name: 'coder' })

    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('sessions/')
    expect(gitignore).toContain('memory/')
    expect(gitignore).toContain('workspace/tmp/')
  })

  test('preserves existing markdown files instead of overwriting', async () => {
    const original = '# existing content\n'
    await writeFile(join(root, 'AGENTS.md'), original)

    await scaffold(root, { name: 'coder' })

    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(original)
  })

  test('preserves existing .gitignore instead of overwriting', async () => {
    const original = 'custom-entry\n'
    await writeFile(join(root, '.gitignore'), original)

    await scaffold(root, { name: 'coder' })

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(original)
  })
})

describe('writeSecrets', () => {
  test('writes FIREWORKS_API_KEY to .env', async () => {
    await writeSecrets(root, { fireworksApiKey: 'fw_test_abc123' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_test_abc123\n')
  })

  test('overwrites an existing .env', async () => {
    await writeFile(join(root, '.env'), 'OLD=1\n')
    await writeSecrets(root, { fireworksApiKey: 'fw_new' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_new\n')
  })
})
