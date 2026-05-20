import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_USER_AGENT,
  USER_AGENT_ENV,
  classifyDashboardCommand,
  hasUserAgentFlag,
  injectUserAgentEnv,
  rewriteDashboardArgs,
  runShim,
} from './shim'

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

  test('injects default user-agent env when caller passes neither flag nor env', async () => {
    const env: Record<string, string | undefined> = {}

    await runShim({
      argv: ['open', 'https://example.com'],
      realBin: '/stub/agent-browser',
      env,
      spawn: () => ({ exited: Promise.resolve(0) }),
    })

    expect(env[USER_AGENT_ENV]).toBe(DEFAULT_USER_AGENT)
  })

  test('respects an explicit --user-agent flag: leaves env unset', async () => {
    const env: Record<string, string | undefined> = {}

    await runShim({
      argv: ['open', 'https://example.com', '--user-agent', 'CustomBot/1.0'],
      realBin: '/stub/agent-browser',
      env,
      spawn: () => ({ exited: Promise.resolve(0) }),
    })

    expect(env[USER_AGENT_ENV]).toBeUndefined()
  })

  test('respects a pre-set AGENT_BROWSER_USER_AGENT env: does not overwrite', async () => {
    const env: Record<string, string | undefined> = { [USER_AGENT_ENV]: 'OperatorOverride/1.0' }

    await runShim({
      argv: ['open', 'https://example.com'],
      realBin: '/stub/agent-browser',
      env,
      spawn: () => ({ exited: Promise.resolve(0) }),
    })

    expect(env[USER_AGENT_ENV]).toBe('OperatorOverride/1.0')
  })

  test('injection applies to dashboard subcommands too', async () => {
    const env: Record<string, string | undefined> = {}

    await runShim({
      argv: ['dashboard'],
      realBin: '/stub/agent-browser',
      env,
      spawn: () => ({ exited: Promise.resolve(0) }),
    })

    expect(env[USER_AGENT_ENV]).toBe(DEFAULT_USER_AGENT)
  })
})

describe('DEFAULT_USER_AGENT', () => {
  test('advertises Linux x86_64 to match the container runtime', () => {
    // The shim only runs inside the TypeClaw Linux container. A macOS or
    // Windows UA would create a platform mismatch that stricter bot detectors
    // (Cloudflare, Akamai) flag as suspicious. Linux UA is also correct on
    // linux/arm64 containers because Chrome does not expose ARM in the UA.
    expect(DEFAULT_USER_AGENT).toContain('X11; Linux x86_64')
    expect(DEFAULT_USER_AGENT).not.toContain('Macintosh')
    expect(DEFAULT_USER_AGENT).not.toContain('Windows')
    expect(DEFAULT_USER_AGENT).not.toContain('HeadlessChrome')
  })
})

describe('hasUserAgentFlag', () => {
  test.each([
    [['--user-agent', 'foo'], true],
    [['--user-agent=foo'], true],
    [['open', 'https://example.com', '--user-agent', 'foo'], true],
    [['open', 'https://example.com'], false],
    [[], false],
    [['--user-agent-extra', 'foo'], false],
  ] as [string[], boolean][])('%j → %s', (argv, expected) => {
    expect(hasUserAgentFlag(argv)).toBe(expected)
  })
})

describe('injectUserAgentEnv', () => {
  test('sets env when neither flag nor env is present', () => {
    const env: Record<string, string | undefined> = {}
    injectUserAgentEnv(['open', 'https://example.com'], env)
    expect(env[USER_AGENT_ENV]).toBe(DEFAULT_USER_AGENT)
  })

  test('skips when --user-agent flag is present', () => {
    const env: Record<string, string | undefined> = {}
    injectUserAgentEnv(['open', '--user-agent', 'Bot/1.0'], env)
    expect(env[USER_AGENT_ENV]).toBeUndefined()
  })

  test('skips when --user-agent=value form is present', () => {
    const env: Record<string, string | undefined> = {}
    injectUserAgentEnv(['open', '--user-agent=Bot/1.0'], env)
    expect(env[USER_AGENT_ENV]).toBeUndefined()
  })

  test('skips when env is already set', () => {
    const env: Record<string, string | undefined> = { [USER_AGENT_ENV]: 'Existing/1.0' }
    injectUserAgentEnv(['open'], env)
    expect(env[USER_AGENT_ENV]).toBe('Existing/1.0')
  })

  test('overwrites when env is set to empty string (treated as unset)', () => {
    const env: Record<string, string | undefined> = { [USER_AGENT_ENV]: '' }
    injectUserAgentEnv(['open'], env)
    expect(env[USER_AGENT_ENV]).toBe(DEFAULT_USER_AGENT)
  })

  test('accepts a custom default for testing', () => {
    const env: Record<string, string | undefined> = {}
    injectUserAgentEnv(['open'], env, 'CustomDefault/2.0')
    expect(env[USER_AGENT_ENV]).toBe('CustomDefault/2.0')
  })
})
