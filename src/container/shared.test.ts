import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDockerAvailable,
  classifyRmStderr,
  containerNameFromCwd,
  DOCKER_NOT_FOUND_STDERR,
  type DockerExec,
  imageTagFromCwd,
  waitForRemoval,
} from './shared'

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

describe('checkDockerAvailable', () => {
  test('returns ok when docker info exits 0', async () => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: '29.4.0\n', stderr: '' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({ ok: true })
  })

  test('classifies as binary-missing when stderr is the ENOENT sentinel', async () => {
    const exec: DockerExec = async () => ({ exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'binary-missing',
      detail: DOCKER_NOT_FOUND_STDERR,
    })
  })

  test('classifies any other non-zero exit as daemon-down', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    })
  })

  test('falls back to a synthetic detail when stderr is empty on non-zero exit', async () => {
    const exec: DockerExec = async () => ({ exitCode: 7, stdout: '', stderr: '   ' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'docker info exited with code 7',
    })
  })

  test('passes the right args to the exec stub', async () => {
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await checkDockerAvailable(exec)

    expect(calls).toEqual([['info', '--format', '{{.ServerVersion}}']])
  })
})

describe('classifyRmStderr', () => {
  test('returns "gone" for "No such container" (case-insensitive)', () => {
    expect(classifyRmStderr('Error: No such container: ati')).toBe('gone')
    expect(classifyRmStderr('error: no such container: ati')).toBe('gone')
  })

  test('returns "in-progress" for "removal of container … is already in progress" (case-insensitive)', () => {
    expect(classifyRmStderr('Error response from daemon: removal of container ati is already in progress')).toBe(
      'in-progress',
    )
    expect(classifyRmStderr('REMOVAL OF CONTAINER X IS ALREADY IN PROGRESS')).toBe('in-progress')
  })

  test('returns null for other stderr (non-benign failures)', () => {
    expect(classifyRmStderr('permission denied')).toBeNull()
    expect(classifyRmStderr('')).toBeNull()
    expect(classifyRmStderr('docker: command not found')).toBeNull()
  })

  test('"no such container" takes precedence when both substrings somehow appear', () => {
    // given: a synthetic stderr that contains both phrases (defensive — we
    // have not seen Docker emit this, but the helper's contract should be
    // total). The 'gone' state is strictly cheaper for callers than
    // 'in-progress', so prefer it when ambiguous.
    expect(classifyRmStderr('Error: No such container: x (removal of container x was already in progress)')).toBe(
      'gone',
    )
  })
})

describe('waitForRemoval', () => {
  test('returns true as soon as docker inspect reports the container gone', async () => {
    // given: an exec that returns "exists" twice then "no such container"
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      if (calls >= 3) return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 1_000, intervalMs: 10 })

    // then
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test('returns false on timeout when the container is still present', async () => {
    // given: an exec that always reports the container exists
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when: a short timeout
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 50, intervalMs: 10 })

    // then
    expect(ok).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test('issues docker inspect with the configured name', async () => {
    const seen: string[][] = []
    const exec: DockerExec = async (args) => {
      seen.push(args)
      return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
    }

    await waitForRemoval(exec, 'anderson', { timeoutMs: 100, intervalMs: 10 })

    expect(seen[0]).toEqual(['inspect', '--format', '{{.State.Running}}', 'anderson'])
  })
})
