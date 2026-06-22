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
        resolveDocker: () => 'docker',
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
        resolveDocker: () => 'docker',
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
        resolveDocker: () => 'docker',
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

  test('spawns the resolved absolute docker binary path so Windows PATHEXT resolution is not left to Bun.spawn', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const spawns: Array<{ cmd: string[] }> = []

    await shell(
      { cwd: folder, shell: '/bin/sh' },
      {
        inspect: async () => ({ exists: true, running: true }),
        resolveDocker: () => 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        spawn: (options) => {
          spawns.push(options)
          return { exited: Promise.resolve(0) }
        },
      },
    )

    expect(spawns[0]?.cmd).toEqual([
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      'exec',
      '-it',
      'coder',
      '/bin/sh',
    ])
  })

  test('reports docker missing before inspecting (so it is not masked as a missing container) and without spawning', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    let inspected = false
    let spawned = false

    const result = await shell(
      { cwd: folder },
      {
        resolveDocker: () => null,
        inspect: async () => {
          inspected = true
          return { exists: true, running: true }
        },
        spawn: () => {
          spawned = true
          return { exited: Promise.resolve(0) }
        },
      },
    )

    expect(result).toEqual({ ok: false, reason: 'Docker is not installed (docker not found on PATH).' })
    expect(inspected).toBe(false)
    expect(spawned).toBe(false)
  })
})
