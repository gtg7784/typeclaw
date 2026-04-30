import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONTAINER_PORT, findFreePort, isPortAllocatedError, parseDockerPortOutput, resolveHostPort } from './port'
import type { DockerExec } from './shared'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-port-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('findFreePort', () => {
  test('returns the preferred port when it is free', async () => {
    // given: a port we believe is free (the kernel-assigned ephemeral one)
    const probe = await listen(0)
    const preferred = (probe.address() as { port: number }).port
    await close(probe)

    // when
    const got = await findFreePort(preferred)

    // then
    expect(got).toBe(preferred)
  })

  test('falls back to a kernel-assigned ephemeral port when preferred is taken', async () => {
    // given: a holder occupying a known port
    const holder = await listen(0)
    const taken = (holder.address() as { port: number }).port
    try {
      // when
      const got = await findFreePort(taken)

      // then
      expect(got).not.toBe(taken)
      expect(got).toBeGreaterThan(0)
      expect(got).toBeLessThanOrEqual(65535)
    } finally {
      await close(holder)
    }
  })

  test('returns a kernel-assigned port when no preferred port is supplied', async () => {
    const got = await findFreePort()
    expect(got).toBeGreaterThan(0)
    expect(got).toBeLessThanOrEqual(65535)
  })

  test('treats preferred=0 as "no preference" and returns an ephemeral port', async () => {
    const got = await findFreePort(0)
    expect(got).toBeGreaterThan(0)
  })
})

describe('parseDockerPortOutput', () => {
  test('parses a single 0.0.0.0 mapping', () => {
    expect(parseDockerPortOutput('0.0.0.0:49160\n')).toBe(49160)
  })

  test('parses a single 127.0.0.1 mapping', () => {
    expect(parseDockerPortOutput('127.0.0.1:51234\n')).toBe(51234)
  })

  test('prefers the IPv4 mapping when both v4 and v6 are present', () => {
    // when: docker emits both IPv4 and IPv6 mappings
    const out = '0.0.0.0:8973\n:::8973\n'

    // then: we pick the IPv4 line (localhost connects resolve v4 first on
    // macOS/Linux, so v4 is the more reliable connect target)
    expect(parseDockerPortOutput(out)).toBe(8973)
  })

  test('parses an IPv6 :::port mapping when no IPv4 mapping is present', () => {
    expect(parseDockerPortOutput(':::49160\n')).toBe(49160)
  })

  test('parses a [::]:port style IPv6 mapping', () => {
    expect(parseDockerPortOutput('[::]:49160\n')).toBe(49160)
  })

  test('returns null on empty output (container not running, no mapping)', () => {
    expect(parseDockerPortOutput('')).toBe(null)
    expect(parseDockerPortOutput('\n\n')).toBe(null)
  })

  test('returns null when the trailing segment is not a valid port', () => {
    expect(parseDockerPortOutput('0.0.0.0:not-a-port\n')).toBe(null)
    expect(parseDockerPortOutput('0.0.0.0:99999\n')).toBe(null)
    expect(parseDockerPortOutput('0.0.0.0:0\n')).toBe(null)
  })

  test('tolerates trailing whitespace and surrounding blank lines', () => {
    expect(parseDockerPortOutput('\n\n0.0.0.0:49160  \n\n')).toBe(49160)
  })
})

describe('isPortAllocatedError', () => {
  test('detects the canonical Docker bind-conflict message', () => {
    const stderr =
      'docker: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint shadowclaw: Bind for :::8973 failed: port is already allocated'
    expect(isPortAllocatedError(stderr)).toBe(true)
  })

  test('detects a kernel-level "address already in use" error', () => {
    expect(isPortAllocatedError('listen tcp 0.0.0.0:8973: bind: address already in use')).toBe(true)
  })

  test('returns false for unrelated docker errors', () => {
    expect(isPortAllocatedError('docker: image not found')).toBe(false)
    expect(isPortAllocatedError('permission denied')).toBe(false)
    expect(isPortAllocatedError('')).toBe(false)
  })
})

type DockerCall = { args: string[] }

function fakeExec(
  handler: (args: string[], call: DockerCall) => { exitCode: number; stdout: string; stderr: string },
): {
  exec: DockerExec
  calls: DockerCall[]
} {
  const calls: DockerCall[] = []
  const exec: DockerExec = async (args) => {
    const call = { args }
    calls.push(call)
    return handler(args, call)
  }
  return { exec, calls }
}

describe('resolveHostPort', () => {
  test('queries `docker port <name> 8973/tcp` and returns the parsed host port', async () => {
    // given: a docker that reports a fresh ephemeral mapping
    const { exec, calls } = fakeExec(() => ({ exitCode: 0, stdout: '0.0.0.0:51234\n', stderr: '' }))
    const folder = join(root, 'coder')
    await mkdir(folder)

    // when
    const port = await resolveHostPort({ cwd: folder, exec, retryMs: 0 })

    // then
    expect(port).toBe(51234)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(['port', 'coder', `${CONTAINER_PORT}/tcp`])
  })

  test('falls back to the supplied fallbackPort when docker port fails', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stdout: '', stderr: 'No such container' }))
    const folder = join(root, 'coder')
    await mkdir(folder)

    const port = await resolveHostPort({ cwd: folder, exec, retryMs: 0, fallbackPort: 8973 })

    expect(port).toBe(8973)
  })

  test('falls back when docker port returns empty output (mapping not yet registered)', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 0, stdout: '\n', stderr: '' }))
    const folder = join(root, 'coder')
    await mkdir(folder)

    const port = await resolveHostPort({ cwd: folder, exec, retryMs: 0, fallbackPort: 9000 })

    expect(port).toBe(9000)
  })

  test('retries when the first probe returns no mapping, eventually succeeding', async () => {
    // given: docker becomes ready on the third probe
    let probes = 0
    const { exec, calls } = fakeExec(() => {
      probes++
      if (probes < 3) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '0.0.0.0:42424\n', stderr: '' }
    })
    const folder = join(root, 'coder')
    await mkdir(folder)

    // when
    const port = await resolveHostPort({ cwd: folder, exec, retryMs: 200, intervalMs: 5 })

    // then
    expect(port).toBe(42424)
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  test('uses the container name derived from the agent folder basename', async () => {
    const { exec, calls } = fakeExec(() => ({ exitCode: 0, stdout: '0.0.0.0:8973\n', stderr: '' }))
    const folder = join(root, 'shadowclaw')
    await mkdir(folder)

    await resolveHostPort({ cwd: folder, exec, retryMs: 0 })

    expect(calls[0]!.args[1]).toBe('shadowclaw')
  })
})
