import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { requireContainerRunning } from './require-running'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-require-running-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('requireContainerRunning', () => {
  test('returns the canonical "not found" reason when the container is missing', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await requireContainerRunning({ cwd: folder }, { inspect: async () => ({ exists: false }) })

    expect(result).toEqual({
      ok: false,
      reason: 'Container coder not found. Run `typeclaw start` first.',
    })
  })

  test('returns the canonical "not running" reason when the container is stopped', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await requireContainerRunning(
      { cwd: folder },
      { inspect: async () => ({ exists: true, running: false }) },
    )

    expect(result).toEqual({
      ok: false,
      reason: 'Container coder is not running. Run `typeclaw start` first.',
    })
  })

  test('returns ok with the resolved container name when running', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await requireContainerRunning(
      { cwd: folder },
      { inspect: async () => ({ exists: true, running: true }) },
    )

    expect(result).toEqual({ ok: true, containerName: 'coder' })
  })

  test('passes the cwd-derived container name to inspect', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const inspected: string[] = []

    await requireContainerRunning(
      { cwd: folder },
      {
        inspect: async (name) => {
          inspected.push(name)
          return { exists: true, running: true }
        },
      },
    )

    expect(inspected).toEqual(['coder'])
  })
})
