import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkDockerAvailable,
  containerNameFromCwd,
  DOCKER_NOT_FOUND_STDERR,
  type DockerExec,
  imageTagFromCwd,
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
