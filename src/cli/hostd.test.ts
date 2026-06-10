import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { configSchema } from '@/config'
import type { StartOptions, StartResult } from '@/container'

import { buildHostdRestart, buildHostdRestartPreflight } from './hostd'

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
      forceBuild: false,
    })
  })

  test('forwards build:true to start() as forceBuild', async () => {
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

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result.ok).toBe(true)
    expect(starts).toHaveLength(1)
    expect(starts[0]?.forceBuild).toBe(true)
  })

  test('refuses daemon-owned restart when hostd source has drifted', async () => {
    const starts: StartOptions[] = []
    const restart = buildHostdRestart(
      join(process.cwd(), 'src/cli/index.ts'),
      {
        validateConfig: () => ({ ok: true }),
        stop: async () => ({ ok: true, containerName: 'agent', running: true }),
        loadConfigSync: () => configSchema.parse({ port: 61234 }),
        start: async (opts) => {
          starts.push(opts)
          return startOk(opts)
        },
      },
      'stale-version',
    )

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('host daemon source has drifted')
    expect(starts).toHaveLength(0)
  })

  test('restart preflight rejects source drift before ACK', async () => {
    const preflight = buildHostdRestartPreflight(join(process.cwd(), 'src/cli/index.ts'), 'stale-version')

    const result = await preflight({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result).toEqual({
      ok: false,
      reason:
        'host daemon source has drifted from the current typeclaw source; run `typeclaw restart --build` from the host-stage agent folder so the daemon respawns before rebuilding the Docker image',
    })
  })

  test('omitted build defaults to forceBuild:false', async () => {
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
    expect(starts[0]?.forceBuild).toBe(false)
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
      tuiToken: 'fake-tui-token',
    },
    containerId: 'container-id',
    built: false,
    hostPort: opts.preferredHostPort,
    tuiToken: 'fake-tui-token',
    hostd: { state: 'registered' },
    alreadyRunning: false,
    autoUpgrade: { kind: 'skipped-no-dep' },
    skippedPlugins: [],
  }
}
