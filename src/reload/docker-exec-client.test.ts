import { describe, expect, test } from 'bun:test'

import type { DockerExec, DockerExecResult } from '@/container'

import { requestReloadViaDockerExec } from './docker-exec-client'

describe('requestReloadViaDockerExec', () => {
  test('runs a container-local reload through docker exec', async () => {
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return result({ stdout: JSON.stringify({ ok: true, results: [{ scope: 'config', ok: true, summary: 'ok' }] }) })
    }

    const results = await requestReloadViaDockerExec({
      cwd: 'dobby',
      token: 'sample-value',
      scope: 'config',
      timeoutMs: 1234,
      exec,
    })

    expect(results).toEqual([{ scope: 'config', ok: true, summary: 'ok' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('dobby')
    expect(calls[0]).toContain('TYPECLAW_TUI_TOKEN=sample-value')
    expect(calls[0]).toContain('TYPECLAW_RELOAD_SCOPE=config')
    expect(calls[0]).toContain('TYPECLAW_RELOAD_TIMEOUT_MS=1234')
  })

  test('omits token and scope env vars when absent', async () => {
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return result({ stdout: JSON.stringify({ ok: true, results: [] }) })
    }

    await requestReloadViaDockerExec({ cwd: 'dobby', token: null, exec })

    expect(calls[0]?.some((arg) => arg.startsWith('TYPECLAW_TUI_TOKEN='))).toBe(false)
    expect(calls[0]?.some((arg) => arg.startsWith('TYPECLAW_RELOAD_SCOPE='))).toBe(false)
  })

  test('surfaces structured container-local reload failures', async () => {
    const exec: DockerExec = async () =>
      result({ exitCode: 1, stdout: JSON.stringify({ ok: false, reason: 'closed' }) })

    await expect(requestReloadViaDockerExec({ cwd: 'dobby', token: null, exec })).rejects.toThrow('closed')
  })

  test('sanitizes docker stderr when docker exec itself fails', async () => {
    const exec: DockerExec = async () =>
      result({
        exitCode: 125,
        stderr: "docker: Error response from daemon: No such container\nRun 'docker run --help' for more information\n",
      })

    await expect(requestReloadViaDockerExec({ cwd: 'dobby', token: null, exec })).rejects.toThrow('No such container')
  })

  test('aborts docker exec when the host-side timeout expires', async () => {
    const exec: DockerExec = async (_args, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return result({ stdout: JSON.stringify({ ok: true, results: [] }) })
    }

    await expect(requestReloadViaDockerExec({ cwd: 'dobby', token: null, timeoutMs: 1, exec })).rejects.toThrow(
      'docker exec timed out after 1ms',
    )
  })
})

function result(overrides: Partial<DockerExecResult>): DockerExecResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides }
}
