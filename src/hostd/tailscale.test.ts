import { describe, expect, test } from 'bun:test'

import {
  createTailscaleServeManager,
  runTailscale,
  tailscaleCandidates,
  type TailscaleExec,
  type TailscaleServeEvent,
} from './tailscale'

type ExecCall = { args: string[] }

function fakeExec(opts: {
  status?: { exitCode: number; stdout: string; stderr: string }
  serveExitCode?: number
  offExitCode?: number
}): { exec: TailscaleExec; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: TailscaleExec = async (args) => {
    calls.push({ args })
    if (args[0] === 'status') return opts.status ?? { exitCode: 0, stdout: '{"BackendState":"Running"}', stderr: '' }
    if (args.includes('off')) return { exitCode: opts.offExitCode ?? 0, stdout: '', stderr: 'off failed' }
    return { exitCode: opts.serveExitCode ?? 0, stdout: '', stderr: 'serve failed' }
  }
  return { exec, calls }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('createTailscaleServeManager', () => {
  test('serves an opened port and removes only that owned serve on close', async () => {
    const { exec, calls } = fakeExec({})
    const events: TailscaleServeEvent[] = []
    const manager = createTailscaleServeManager({
      containerName: 'coder',
      exec,
      onEvent: (event) => events.push(event),
    })

    manager.servePort(5173)
    await settle()
    manager.stopPort(5173)
    await manager.stopAll()

    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--json'],
      ['serve', '--bg', '--tcp=5173', '5173'],
      ['serve', '--tcp=5173', 'off'],
    ])
    expect(events).toEqual([
      { kind: 'tailscale-serve-opened', containerName: 'coder', port: 5173 },
      { kind: 'tailscale-serve-closed', containerName: 'coder', port: 5173 },
    ])
  })

  test('skips serving when tailscale is disconnected', async () => {
    const { exec, calls } = fakeExec({ status: { exitCode: 0, stdout: '{"BackendState":"Stopped"}', stderr: '' } })
    const events: TailscaleServeEvent[] = []
    const manager = createTailscaleServeManager({
      containerName: 'coder',
      exec,
      onEvent: (event) => events.push(event),
    })

    manager.servePort(5173)
    await manager.stopAll()

    expect(calls.map((call) => call.args)).toEqual([['status', '--json']])
    expect(events).toEqual([
      { kind: 'tailscale-serve-skipped', containerName: 'coder', port: 5173, reason: 'tailscale backend is Stopped' },
    ])
  })

  test('reports malformed status JSON as a non-fatal skip', async () => {
    const { exec } = fakeExec({ status: { exitCode: 0, stdout: 'not json', stderr: '' } })
    const events: TailscaleServeEvent[] = []
    const manager = createTailscaleServeManager({
      containerName: 'coder',
      exec,
      onEvent: (event) => events.push(event),
    })

    manager.servePort(5173)
    await manager.stopAll()

    expect(events[0]).toMatchObject({
      kind: 'tailscale-serve-skipped',
      containerName: 'coder',
      port: 5173,
    })
    expect(events[0]?.kind === 'tailscale-serve-skipped' ? events[0].reason : '').toContain(
      'invalid tailscale status JSON',
    )
  })

  test('reports serve failures without claiming ownership', async () => {
    const { exec, calls } = fakeExec({ serveExitCode: 1 })
    const events: TailscaleServeEvent[] = []
    const manager = createTailscaleServeManager({
      containerName: 'coder',
      exec,
      onEvent: (event) => events.push(event),
    })

    manager.servePort(5173)
    await settle()
    manager.stopPort(5173)
    await manager.stopAll()

    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--json'],
      ['serve', '--bg', '--tcp=5173', '5173'],
    ])
    expect(events).toEqual([
      {
        kind: 'tailscale-serve-failed',
        containerName: 'coder',
        port: 5173,
        command: 'serve',
        reason: 'serve failed',
      },
    ])
  })
})

describe('tailscaleCandidates', () => {
  test('macOS includes the app-bundle CLI fallback after PATH', () => {
    const candidates = tailscaleCandidates('darwin')
    expect(candidates[0]).toBe('tailscale')
    expect(candidates.some((c) => c.includes('Tailscale.app'))).toBe(true)
  })

  test('Windows includes the default install path fallback after PATH', () => {
    const candidates = tailscaleCandidates('win32')
    expect(candidates[0]).toBe('tailscale')
    expect(candidates.some((c) => c.toLowerCase().endsWith('tailscale.exe'))).toBe(true)
  })

  test('Linux uses PATH only', () => {
    expect(tailscaleCandidates('linux')).toEqual(['tailscale'])
  })
})

describe('runTailscale subprocess timeout', () => {
  test('kills a hung CLI call and returns exit 124 instead of blocking forever', async () => {
    const start = Date.now()
    const result = await runTailscale('sh', ['-c', 'sleep 30'], 50)
    const elapsed = Date.now() - start

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain('timed out after 50ms')
    expect(elapsed).toBeLessThan(5_000)
  })

  test('returns stdout/stderr for a CLI call that exits before the timeout', async () => {
    const result = await runTailscale('sh', ['-c', 'echo hi; echo oops 1>&2; exit 3'], 5_000)

    expect(result.exitCode).toBe(3)
    expect(result.stdout.trim()).toBe('hi')
    expect(result.stderr.trim()).toBe('oops')
  })
})
