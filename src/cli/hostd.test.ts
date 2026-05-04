import { describe, expect, test } from 'bun:test'

import { configSchema } from '@/config'
import type { StartOptions, StartResult } from '@/container'

import { buildHostdRestart } from './hostd'

describe('buildHostdRestart', () => {
  test('restarts through the already-running hostd instead of triggering drift respawn', async () => {
    const starts: StartOptions[] = []
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      stop: async () => ({ ok: true, containerName: 'agent', running: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      start: async (opts) => {
        starts.push(opts)
        return startOk(opts)
      },
    })

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir' })

    expect(result.ok).toBe(true)
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      cwd: '/agent-dir',
      preferredHostPort: 61234,
      cliEntry: '/repo/src/cli/index.ts',
      reuseCurrentHostDaemon: true,
    })
  })
})

function startOk(opts: StartOptions): StartResult {
  return {
    ok: true,
    plan: {
      containerName: 'agent',
      imageTag: 'typeclaw-agent',
      buildContext: opts.cwd,
      dockerfile: `${opts.cwd}/Dockerfile`,
      runArgs: ['run'],
      needsBuild: false,
      hostPort: opts.preferredHostPort,
    },
    containerId: 'container-id',
    built: false,
    hostPort: opts.preferredHostPort,
    hostd: { state: 'registered' },
  }
}
