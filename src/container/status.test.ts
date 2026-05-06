import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec, DockerExecResult } from './shared'
import { status } from './status'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-status-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type FakeDockerOptions = {
  inspect?: DockerExecResult
  port?: DockerExecResult
}

function fakeExec(opts: FakeDockerOptions): DockerExec {
  return async (args) => {
    if (args[0] === 'inspect') {
      return opts.inspect ?? { exitCode: 1, stdout: '', stderr: 'no inspect stub' }
    }
    if (args[0] === 'port') {
      return opts.port ?? { exitCode: 1, stdout: '', stderr: 'no port stub' }
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }
}

describe('status', () => {
  test('reports missing when docker inspect exits non-zero', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await status({
      cwd: folder,
      exec: fakeExec({ inspect: { exitCode: 1, stdout: '', stderr: 'No such object' } }),
    })

    expect(result).toEqual({ kind: 'missing', containerName: 'coder', imageTag: 'typeclaw-coder' })
  })

  test('reports stopped when inspect succeeds but Running is false', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await status({
      cwd: folder,
      exec: fakeExec({
        inspect: { exitCode: 0, stdout: 'false|sha256:abc123|typeclaw-coder\n', stderr: '' },
      }),
    })

    expect(result).toEqual({
      kind: 'stopped',
      containerName: 'coder',
      imageTag: 'typeclaw-coder',
      containerId: 'sha256:abc123',
      configuredImage: 'typeclaw-coder',
    })
  })

  test('reports running with parsed host port and bind address', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await status({
      cwd: folder,
      exec: fakeExec({
        inspect: { exitCode: 0, stdout: 'true|sha256:def456|typeclaw-coder\n', stderr: '' },
        port: { exitCode: 0, stdout: '0.0.0.0:51234\n:::51234\n', stderr: '' },
      }),
    })

    expect(result).toEqual({
      kind: 'running',
      containerName: 'coder',
      imageTag: 'typeclaw-coder',
      containerId: 'sha256:def456',
      configuredImage: 'typeclaw-coder',
      hostPort: 51234,
      hostBindAddr: '0.0.0.0',
    })
  })

  test('prefers IPv4 mapping when docker reports both', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await status({
      cwd: folder,
      exec: fakeExec({
        inspect: { exitCode: 0, stdout: 'true|sha256:1|typeclaw-coder\n', stderr: '' },
        port: { exitCode: 0, stdout: ':::51234\n127.0.0.1:51234\n', stderr: '' },
      }),
    })

    expect(result).toMatchObject({ kind: 'running', hostPort: 51234, hostBindAddr: '127.0.0.1' })
  })

  test('returns running with null port when docker port mapping is missing', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    const result = await status({
      cwd: folder,
      exec: fakeExec({
        inspect: { exitCode: 0, stdout: 'true|sha256:1|typeclaw-coder\n', stderr: '' },
        port: { exitCode: 1, stdout: '', stderr: 'Error: No public port' },
      }),
    })

    expect(result).toMatchObject({ kind: 'running', hostPort: null, hostBindAddr: null })
  })
})
