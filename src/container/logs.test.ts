import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planLogs } from './logs'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-logs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planLogs', () => {
  test('derives container name from the folder basename and carries follow flag through', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planLogs(folder, { follow: false })).toEqual({ containerName: 'coder', follow: false })
    expect(planLogs(folder, { follow: true })).toEqual({ containerName: 'coder', follow: true })
  })
})
