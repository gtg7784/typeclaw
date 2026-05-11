import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec, DockerExecResult } from './shared'
import { planStop, stop } from './stop'

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

type ContainerScenario = { exists: false } | { exists: true; running: boolean }

type FakeOptions = {
  scenario: ContainerScenario
  stopFails?: boolean
  rmStderr?: string
  rmExitCode?: number
  inspectExitCode?: number
  inspectStderr?: string
}

function fakeDockerExec(options: FakeOptions): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = []
  let scenario = options.scenario
  const exec: DockerExec = async (args): Promise<DockerExecResult> => {
    calls.push(args)
    if (args[0] === 'inspect') {
      if (options.inspectExitCode !== undefined && options.inspectExitCode !== 0) {
        return { exitCode: options.inspectExitCode, stdout: '', stderr: options.inspectStderr ?? '' }
      }
      if (!scenario.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: `${scenario.running}\n`, stderr: '' }
    }
    if (args[0] === 'stop') {
      if (options.stopFails) return { exitCode: 1, stdout: '', stderr: 'docker stop failed' }
      if (scenario.exists) scenario = { exists: true, running: false }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'rm') {
      const exitCode = options.rmExitCode ?? 0
      const stderr = options.rmStderr ?? ''
      if (exitCode === 0) scenario = { exists: false }
      return { exitCode, stdout: '', stderr }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

describe('stop (composition)', () => {
  test('returns ok with running=false when the container does not exist', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: false } })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'stop')).toBeUndefined()
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('calls docker stop THEN docker rm when the container is running', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: true } })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(true)
    const stopIdx = calls.findIndex((c) => c[0] === 'stop')
    const rmIdx = calls.findIndex((c) => c[0] === 'rm')
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(rmIdx).toBeGreaterThan(stopIdx)
  })

  test('skips docker stop but still issues docker rm -f when the container exists in stopped state (post-crash corpse)', async () => {
    const { exec, calls } = fakeDockerExec({ scenario: { exists: true, running: false } })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'stop')).toBeUndefined()
    expect(calls.find((c) => c[0] === 'rm' && c[1] === '-f')).toBeDefined()
  })

  test('tolerates "no such container" from docker rm (user removed it out-of-band)', async () => {
    const { exec } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 1,
      rmStderr: 'Error: No such container: vanished',
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
  })

  test('surfaces a clear error when docker rm fails for a non-recoverable reason', async () => {
    const { exec } = fakeDockerExec({
      scenario: { exists: true, running: false },
      rmExitCode: 1,
      rmStderr: 'permission denied',
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/docker rm failed.*permission denied/)
  })

  test('surfaces a clear error when docker stop itself fails (does not proceed to rm)', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      stopFails: true,
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/docker stop failed/)
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('force-removes the corpse when docker inspect fails with a non-"no such container" error', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: false },
      inspectExitCode: 1,
      inspectStderr: 'Error response from daemon: removal of container abc is already in progress',
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'rm' && c[1] === '-f')).toBeDefined()
  })

  test('short-circuits without docker rm when docker inspect reports the container truly does not exist', async () => {
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: false },
      inspectExitCode: 1,
      inspectStderr: 'Error: No such container: anderson',
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.running).toBe(false)
    expect(calls.find((c) => c[0] === 'rm')).toBeUndefined()
  })

  test('surfaces a clear error when docker inspect fails AND the recovery docker rm -f also fails', async () => {
    const { exec } = fakeDockerExec({
      scenario: { exists: true, running: false },
      inspectExitCode: 1,
      inspectStderr: 'Error response from daemon: removal of container abc is already in progress',
      rmExitCode: 1,
      rmStderr: 'permission denied',
    })

    const result = await stop({ cwd: root, exec })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/docker inspect failed/)
    expect(result.reason).toMatch(/docker rm -f could not recover.*permission denied/)
  })
})
