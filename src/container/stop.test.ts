import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planStop } from './stop'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-stop-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planStop', () => {
  test('derives container name from the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planStop(folder)).toEqual({ containerName: 'coder' })
  })
})
