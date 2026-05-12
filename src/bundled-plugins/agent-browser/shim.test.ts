import { describe, expect, test } from 'bun:test'

import { classifyDashboardCommand, rewriteDashboardArgs, runShim } from './shim'

describe('classifyDashboardCommand', () => {
  test.each([
    ['dashboard', 'start'],
    ['dashboard start', 'start'],
    ['dashboard start --port 4849', 'start'],
    ['dashboard --port 4849', 'start'],
    ['dashboard stop', 'stop'],
    ['dashboard stop --json', 'stop'],
    ['open https://example.com', 'other'],
    ['snapshot', 'other'],
    ['skills get core', 'other'],
    ['', 'other'],
  ])('%s → %s', (cmd, expected) => {
    expect(classifyDashboardCommand(cmd.split(' ').filter(Boolean))).toBe(expected as never)
  })

  test('classifies an unknown subcommand as other so we do not rewrite for it', () => {
    expect(classifyDashboardCommand(['dashboard', 'reload'])).toBe('other')
  })

  test('skips leading global flags so a future global flag does not break detection', () => {
    expect(classifyDashboardCommand(['--verbose', 'dashboard'])).toBe('start')
    expect(classifyDashboardCommand(['--verbose', 'open', 'https://example.com'])).toBe('other')
  })
})

describe('rewriteDashboardArgs', () => {
  test('inserts start subcommand and --port when the caller relied on implicit start', () => {
    expect(rewriteDashboardArgs(['dashboard'], 4849)).toEqual(['dashboard', 'start', '--port', '4849'])
  })

  test('preserves an explicit start and appends --port', () => {
    expect(rewriteDashboardArgs(['dashboard', 'start'], 4849)).toEqual(['dashboard', 'start', '--port', '4849'])
  })

  test('strips and replaces a user --port to prevent bypassing the proxy', () => {
    expect(rewriteDashboardArgs(['dashboard', 'start', '--port', '9999'], 4849)).toEqual([
      'dashboard',
      'start',
      '--port',
      '4849',
    ])
    expect(rewriteDashboardArgs(['dashboard', 'start', '-p', '9999'], 4849)).toEqual([
      'dashboard',
      'start',
      '--port',
      '4849',
    ])
    expect(rewriteDashboardArgs(['dashboard', 'start', '--port=9999'], 4849)).toEqual([
      'dashboard',
      'start',
      '--port',
      '4849',
    ])
  })

  test('handles implicit-start with --port: synthesizes start AND drops the user --port', () => {
    expect(rewriteDashboardArgs(['dashboard', '--port', '9999'], 4849)).toEqual([
      'dashboard',
      'start',
      '--port',
      '4849',
    ])
  })

  test('preserves non-port flags', () => {
    expect(rewriteDashboardArgs(['dashboard', 'start', '--json', '--port', '9999'], 4849)).toEqual([
      'dashboard',
      'start',
      '--json',
      '--port',
      '4849',
    ])
  })
})

describe('runShim', () => {
  test('passthrough: spawns real bin with unchanged argv for non-dashboard commands', async () => {
    const spawned: string[][] = []

    const exit = await runShim({
      argv: ['open', 'https://example.com'],
      realBin: '/stub/agent-browser',
      upstreamPort: 4849,
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(exit).toBe(0)
    expect(spawned).toEqual([['/stub/agent-browser', 'open', 'https://example.com']])
  })

  test('dashboard stop: passthrough, no rewrite', async () => {
    const spawned: string[][] = []

    const exit = await runShim({
      argv: ['dashboard', 'stop'],
      realBin: '/stub/agent-browser',
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(exit).toBe(0)
    expect(spawned).toEqual([['/stub/agent-browser', 'dashboard', 'stop']])
  })

  test('dashboard start: rewrites --port to upstream port and spawns real bin', async () => {
    const spawned: string[][] = []

    const exit = await runShim({
      argv: ['dashboard', 'start', '--port', '9999'],
      realBin: '/stub/agent-browser',
      upstreamPort: 4849,
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(exit).toBe(0)
    expect(spawned).toEqual([['/stub/agent-browser', 'dashboard', 'start', '--port', '4849']])
  })

  test('dashboard (implicit start): synthesizes start subcommand', async () => {
    const spawned: string[][] = []

    await runShim({
      argv: ['dashboard'],
      realBin: '/stub/agent-browser',
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(spawned).toEqual([['/stub/agent-browser', 'dashboard', 'start', '--port', '4849']])
  })

  test('propagates the real binary exit code', async () => {
    const exit = await runShim({
      argv: ['dashboard'],
      realBin: '/stub/agent-browser',
      spawn: () => ({ exited: Promise.resolve(42) }),
    })

    expect(exit).toBe(42)
  })
})
