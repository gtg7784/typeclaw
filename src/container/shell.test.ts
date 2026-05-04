import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planShell, shell } from './shell'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-shell-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('planShell', () => {
  test('derives container name from the folder basename and defaults to bash', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planShell(folder)).toEqual({ containerName: 'coder', shell: '/bin/bash' })
  })

  test('carries a custom shell through', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(planShell(folder, { shell: '/bin/sh' })).toEqual({ containerName: 'coder', shell: '/bin/sh' })
  })
})

describe('shell', () => {
  test('asks the user to start the container when it is missing', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await shell(
      { cwd: folder },
      {
        inspect: async () => ({ exists: false }),
        spawn: () => ({ exited: Promise.resolve(0) }),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'Container coder not found. Run `typeclaw start` first.' })
  })

  test('asks the user to start the container when it is stopped', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await shell(
      { cwd: folder },
      {
        inspect: async () => ({ exists: true, running: false }),
        spawn: () => ({ exited: Promise.resolve(0) }),
      },
    )

    expect(result).toEqual({ ok: false, reason: 'Container coder is not running. Run `typeclaw start` first.' })
  })

  test('runs docker exec with interactive stdio in the agent folder', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const spawns: Array<{
      cmd: string[]
      cwd: string
      stdin: 'inherit'
      stdout: 'inherit'
      stderr: 'inherit'
    }> = []

    const result = await shell(
      { cwd: folder, shell: '/bin/sh' },
      {
        inspect: async () => ({ exists: true, running: true }),
        spawn: (options) => {
          spawns.push(options)
          return { exited: Promise.resolve(7) }
        },
      },
    )

    expect(result).toEqual({ ok: true, containerName: 'coder', exitCode: 7 })
    expect(spawns).toEqual([
      {
        cmd: ['docker', 'exec', '-it', 'coder', '/bin/sh'],
        cwd: folder,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    ])
  })
})
