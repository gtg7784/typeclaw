import { describe, expect, test } from 'bun:test'

import type { DockerExec } from '@/container'

import { preflightDocker } from './docker-preflight'

function execReturning(exitCode: number, stderr = ''): DockerExec {
  return async () => ({ exitCode, stdout: exitCode === 0 ? '27.0.0' : '', stderr })
}

describe('preflightDocker', () => {
  test('ok when docker info succeeds', async () => {
    const result = await preflightDocker(execReturning(0))
    expect(result.ok).toBe(true)
  })

  test('daemon-down yields a non-ok result with summary and guidance', async () => {
    const stderr =
      'failed to connect to the docker API at unix:///home/user/.docker/run/docker.sock; check if the daemon is running'
    const result = await preflightDocker(execReturning(1, stderr))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.summary.length).toBeGreaterThan(0)
    expect(result.guidance.length).toBeGreaterThan(0)
  })

  test('binary-missing yields install guidance', async () => {
    const result = await preflightDocker(execReturning(-1, 'docker: command not found in $PATH'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.summary).toBe('Docker is not installed.')
    expect(result.guidance.join('\n')).toContain('https://orbstack.dev')
  })
})
