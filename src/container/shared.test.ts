import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { containerNameFromCwd, imageTagFromCwd, waitForRemoval } from './shared'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-shared-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('containerNameFromCwd', () => {
  test('uses the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('coder')
  })

  test('replaces disallowed characters with dashes', async () => {
    const folder = join(root, 'my agent@v2')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('my-agent-v2')
  })

  test('prefixes tc- when the name does not start with alphanumeric', async () => {
    const folder = join(root, '.hidden')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('tc-.hidden')
  })
})

describe('imageTagFromCwd', () => {
  test('prefixes with typeclaw-', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(imageTagFromCwd(folder)).toBe('typeclaw-coder')
  })
})

describe('waitForRemoval', () => {
  test('returns true immediately when the container is already gone', async () => {
    const result = await waitForRemoval('absent', {
      timeoutMs: 1000,
      intervalMs: 10,
      probe: async () => false,
    })

    expect(result).toBe(true)
  })

  test('polls until the container disappears, then returns true', async () => {
    let calls = 0
    const result = await waitForRemoval('vanishing', {
      timeoutMs: 1000,
      intervalMs: 5,
      probe: async () => {
        calls += 1
        return calls < 3
      },
    })

    expect(result).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('returns false when the container is still present at the deadline', async () => {
    const result = await waitForRemoval('stuck', {
      timeoutMs: 50,
      intervalMs: 5,
      probe: async () => true,
    })

    expect(result).toBe(false)
  })
})
