import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_VERSION, resolveBaseImageVersion } from './cli-version'

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-cli-version-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeAgentPackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test-agent', dependencies: deps }))
}

describe('resolveBaseImageVersion', () => {
  test('returns CLI_VERSION when the agent package.json declares typeclaw via a registry-style spec', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: '^0.1.1' })
      expect(await resolveBaseImageVersion(dir)).toBe(CLI_VERSION)
    })
  })

  test('also returns CLI_VERSION for exact and tag specs (real installs)', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: '0.1.1' })
      expect(await resolveBaseImageVersion(dir)).toBe(CLI_VERSION)
    })
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: 'latest' })
      expect(await resolveBaseImageVersion(dir)).toBe(CLI_VERSION)
    })
  })

  test('returns null for file: specs (dev mode — version not yet on GHCR)', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: 'file:../typeclaw' })
      expect(await resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null for link: specs', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: 'link:../typeclaw' })
      expect(await resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null when agent package.json is missing (tmp dirs, fresh scaffolds)', async () => {
    await withTmpDir(async (dir) => {
      expect(await resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null when typeclaw is not in dependencies', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { 'some-other-dep': '^1.0.0' })
      expect(await resolveBaseImageVersion(dir)).toBeNull()
    })
  })
})

describe('CLI_VERSION', () => {
  test('matches a valid semver shape (read from package.json#version at module load)', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
