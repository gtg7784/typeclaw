import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTROLLER_UNSUPPORTED_REASON,
  LocalDockerController,
  NoopController,
  resolveController,
  resolveDeploymentProfile,
} from './controller'
import { containerNameFromCwd, type DockerExec, type DockerExecResult, imageTagFromCwd } from './shared'

function fakeExec(handler: (args: string[]) => DockerExecResult): DockerExec {
  return async (args) => handler(args)
}

describe('LocalDockerController', () => {
  test('status delegates to the docker inspect path via the injected exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-controller-'))
    try {
      const exec = fakeExec((args) => {
        if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'no such container' }
        return { exitCode: 0, stdout: '', stderr: '' }
      })

      const result = await new LocalDockerController().status({ cwd: root, exec })

      expect(result.kind).toBe('missing')
      expect(result.containerName).toBe(containerNameFromCwd(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stop delegates to the docker stop/rm path via the injected exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-controller-'))
    try {
      const calls: string[][] = []
      const exec = fakeExec((args) => {
        calls.push(args)
        // First inspect: container is a stopped corpse. The post-rm
        // waitForRemoval poll then sees it gone so stop() returns promptly.
        if (args[0] === 'inspect') {
          const seenInspects = calls.filter((c) => c[0] === 'inspect').length
          return seenInspects === 1
            ? { exitCode: 0, stdout: 'false\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'no such container' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      })

      const result = await new LocalDockerController().stop({ cwd: root, exec })

      expect(result.ok).toBe(true)
      expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('NoopController', () => {
  const cwd = '/agent'

  test('start fails loud with the unsupported reason', async () => {
    const result = await new NoopController().start({ cwd, preferredHostPort: 8973 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
    expect(result.reason).toContain('start')
  })

  test('stop fails loud with the unsupported reason', async () => {
    const result = await new NoopController().stop({ cwd })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('logs fails loud with the unsupported reason', async () => {
    const result = await new NoopController().logs({ cwd, follow: false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('shell fails loud with the unsupported reason', async () => {
    const result = await new NoopController().shell({ cwd })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('status reports missing since typeclaw does not orchestrate the container', async () => {
    const result = await new NoopController().status({ cwd })
    expect(result.kind).toBe('missing')
    expect(result.containerName).toBe(containerNameFromCwd(cwd))
    expect(result.imageTag).toBe(imageTagFromCwd(cwd))
  })
})

describe('resolveController', () => {
  test('host profile resolves to LocalDockerController', () => {
    expect(resolveController('host')).toBeInstanceOf(LocalDockerController)
  })

  test('managed profile resolves to NoopController', () => {
    expect(resolveController('managed')).toBeInstanceOf(NoopController)
  })

  test('defaults to the host controller (no managed runtime yet)', () => {
    expect(resolveController()).toBeInstanceOf(LocalDockerController)
  })
})

describe('resolveDeploymentProfile', () => {
  test('resolves to host (the only reachable profile today)', () => {
    expect(resolveDeploymentProfile()).toBe('host')
  })
})
