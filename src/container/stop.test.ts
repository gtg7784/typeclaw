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
  // Models Docker's async removal-drain after `docker rm`. The container
  // does NOT immediately disappear from `docker inspect`. It only transitions
  // to "no such container" after the inspect probe has been called this
  // many times (simulating the drain completing). Default 0 — no drain
  // delay — i.e. inspect reports "gone" the very next call. Set to a
  // positive integer to exercise waitForRemoval's polling loop; set high
  // enough to exhaust the configured timeout to exercise the timeout branch.
  // Applies BOTH to the "in-progress" non-zero rm and to the exit-0 rm
  // (OrbStack/Docker Desktop under load acknowledge the rm before draining).
  drainAfterInspectCalls?: number
}

function fakeDockerExec(options: FakeOptions): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = []
  let scenario = options.scenario
  let inspectsAfterRm = 0
  let rmReturned = false
  const exec: DockerExec = async (args): Promise<DockerExecResult> => {
    calls.push(args)
    if (args[0] === 'inspect') {
      if (rmReturned) {
        inspectsAfterRm += 1
        if (inspectsAfterRm > (options.drainAfterInspectCalls ?? 0)) {
          scenario = { exists: false }
        }
      }
      if (options.inspectExitCode !== undefined && options.inspectExitCode !== 0 && !rmReturned) {
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
      rmReturned = true
      // Exit 0 from `docker rm -f` does NOT mean the container is gone on
      // OrbStack under load — the daemon acknowledges the rm before
      // draining. Defer the scenario transition to the inspect drain logic
      // above so tests with drainAfterInspectCalls > 0 model the real race
      // window. drainAfterInspectCalls === 0 (the default) still flips
      // scenario on the very next inspect probe, so existing exit-0 tests
      // continue to see "gone" immediately.
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

  test('waits for the drain when docker rm returns "removal already in progress" and succeeds', async () => {
    // given: docker stop succeeded, but rm finds the container is being
    // removed by something else (peer typeclaw stop / OrbStack async cleanup
    // / hostd GC). Docker will finish the drain a few hundred ms later.
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 1,
      rmStderr: 'Error response from daemon: removal of container vanished is already in progress',
      drainAfterInspectCalls: 2,
    })

    // when
    const result = await stop({ cwd: root, exec })

    // then: stop reports success, AND we polled inspect at least until the
    // container actually disappeared — caller can safely docker run --name
    expect(result.ok).toBe(true)
    const inspectAfterRm = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c[0] === 'inspect')
      .filter(({ i }) => i > calls.findIndex((cc) => cc[0] === 'rm'))
    expect(inspectAfterRm.length).toBeGreaterThanOrEqual(2)
  })

  test('waits for the drain when docker rm returns exit 0 but the container is still in inspect (OrbStack under load)', async () => {
    // given: a running container. `docker rm -f` returns exit 0 but Docker
    // has not yet finished draining — `inspect` still sees the container
    // for two more probes. This is the canonical OrbStack-under-load
    // failure mode behind `typeclaw compose restart`'s "Conflict. The
    // container name is already in use" — stop() returning before the
    // drain completes lets the subsequent start() race the daemon.
    const { exec, calls } = fakeDockerExec({
      scenario: { exists: true, running: true },
      rmExitCode: 0,
      drainAfterInspectCalls: 2,
    })

    // when
    const result = await stop({ cwd: root, exec })

    // then: stop reports success only AFTER inspect confirmed the name is
    // free — at least one inspect probe must run between rm and return.
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c[0] === 'rm')
    const inspectAfterRm = calls.slice(rmIdx + 1).filter((c) => c[0] === 'inspect')
    expect(inspectAfterRm.length).toBeGreaterThanOrEqual(1)
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
