import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareWindowsDevJunction, type SymlinkImpl } from './windows-dev-link'

async function agentDirWith(typeclawSpec: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tc-win-devlink-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { typeclaw: typeclawSpec } }))
  return dir
}

function recordingSymlink(): { impl: SymlinkImpl; calls: { target: string; path: string; type: string }[] } {
  const calls: { target: string; path: string; type: string }[] = []
  const impl: SymlinkImpl = async (target, path, type) => {
    calls.push({ target, path, type })
  }
  return { impl, calls }
}

describe('prepareWindowsDevJunction', () => {
  test('creates a junction to the checkout on Windows with a local file: dep', async () => {
    const dir = await agentDirWith('file:../checkout')
    try {
      const { impl, calls } = recordingSymlink()

      const result = await prepareWindowsDevJunction(dir, { platform: 'win32', symlinkImpl: impl })

      expect(result).toEqual({ created: true, target: join(dir, '..', 'checkout') })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.type).toBe('junction')
      expect(calls[0]?.path).toBe(join(dir, 'node_modules', 'typeclaw'))
      expect(calls[0]?.target).toBe(join(dir, '..', 'checkout'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is a no-op on POSIX even with a local file: dep', async () => {
    const dir = await agentDirWith('file:../checkout')
    try {
      const { impl, calls } = recordingSymlink()

      const result = await prepareWindowsDevJunction(dir, { platform: 'linux', symlinkImpl: impl })

      expect(result).toBeNull()
      expect(calls).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is a no-op for a registry spec on Windows', async () => {
    const dir = await agentDirWith('^0.39.1')
    try {
      const { impl, calls } = recordingSymlink()

      const result = await prepareWindowsDevJunction(dir, { platform: 'win32', symlinkImpl: impl })

      expect(result).toBeNull()
      expect(calls).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not recreate an existing node_modules/typeclaw (idempotent re-init)', async () => {
    const dir = await agentDirWith('file:../checkout')
    try {
      const { impl, calls } = recordingSymlink()
      // given: node_modules/typeclaw already materialized by a prior init
      await writeFile(join(dir, 'package.json.bak'), '')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dir, 'node_modules', 'typeclaw'), { recursive: true })

      const result = await prepareWindowsDevJunction(dir, { platform: 'win32', symlinkImpl: impl })

      expect(result).toEqual({ created: false, target: join(dir, '..', 'checkout') })
      expect(calls).toHaveLength(0)
      expect(existsSync(join(dir, 'node_modules', 'typeclaw'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
