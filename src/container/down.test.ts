import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDown } from './down'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-down-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planDown', () => {
  test('derives container name from the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planDown(folder)).toEqual({ containerName: 'coder' })
  })
})
