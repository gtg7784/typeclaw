import { describe, expect, test } from 'bun:test'

import { DEFAULT_USER_AGENT, USER_AGENT_ENV, hasUserAgentFlag, injectUserAgentEnv, runShim } from './shim'

describe('runShim', () => {
  test('spawns real bin with unchanged argv for non-dashboard commands', async () => {
    const spawned: string[][] = []

    const exit = await runShim({
      argv: ['open', 'https://example.com'],
      realBin: '/stub/agent-browser',
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(exit).toBe(0)
    expect(spawned).toEqual([['/stub/agent-browser', 'open', 'https://example.com']])
  })

  test('dashboard start argv passes through unchanged', async () => {
    const spawned: string[][] = []

    const exit = await runShim({
      argv: ['dashboard', 'start', '--port', '9999'],
      realBin: '/stub/agent-browser',
      spawn: (cmd) => {
        spawned.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })

    expect(exit).toBe(0)
    expect(spawned).toEqual([['/stub/agent-browser', 'dashboard', 'start', '--port', '9999']])
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
