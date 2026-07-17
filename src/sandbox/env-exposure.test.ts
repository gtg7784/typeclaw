import { describe, expect, test } from 'bun:test'

import { resolveExposableEnvNames } from './env-exposure'

const env = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries))

describe('resolveExposableEnvNames', () => {
  test('exposes every operator-declared .env var by default', () => {
    const names = resolveExposableEnvNames(
      env({
        AGENT_MESSENGER_CONFIG_DIR: '/agent/workspace/.config/agent-messenger',
        DATABASE_URL: 'postgres://u:p@host/db',
        OPENAI_API_KEY: 'sk-x',
      }),
    )
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR', 'DATABASE_URL', 'OPENAI_API_KEY'])
  })

  test('withholds sandbox-owned names (PATH/HOME/BUN_*/LANG)', () => {
    const names = resolveExposableEnvNames(
      env({ PATH: '/evil', HOME: '/evil', BUN_TMPDIR: '/evil', BUN_INSTALL: '/evil', LANG: 'x', MY_VAR: 'ok' }),
    )
    expect(names).toEqual(['MY_VAR'])
  })

  test('withholds runtime/broker-owned credential names (GH_TOKEN, GITHUB_TOKEN, TYPECLAW_*)', () => {
    const names = resolveExposableEnvNames(
      env({
        GH_TOKEN: 'ghp_x',
        GITHUB_TOKEN: 'ghp_y',
        TYPECLAW_TUI_TOKEN: 'a',
        TYPECLAW_HOSTD_TOKEN: 'b',
        TYPECLAW_HOSTD_BROKER_TOKEN: 'c',
        MY_VAR: 'ok',
      }),
    )
    expect(names).toEqual(['MY_VAR'])
  })

  test('withholds outer-shell bash controls and BASH_FUNC_ imports', () => {
    const names = resolveExposableEnvNames(
      env({
        SHELLOPTS: 'xtrace',
        BASHOPTS: 'x',
        PS4: '$(touch /pwned)',
        BASH_XTRACEFD: '2',
        BASH_ENV: '/x',
        'BASH_FUNC_bwrap%%': '() { true; }',
        SAFE: 'ok',
      }),
    )
    expect(names).toEqual(['SAFE'])
  })

  test('withholds loader/interpreter-hijack vars', () => {
    const names = resolveExposableEnvNames(
      env({ LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x', GIT_CONFIG_GLOBAL: '/x', SSH_AUTH_SOCK: '/x', OK: 'y' }),
    )
    expect(names).toEqual(['OK'])
  })

  test('an EMPTY .env declaration is ineligible even if secrets.json later fills process.env', () => {
    // .env has `DISCORD_BOT_TOKEN=` (empty); hydrateChannelEnvFromSecrets would
    // populate process.env[DISCORD_BOT_TOKEN] from secrets.json. Eligibility is
    // from the parsed FILE value, so the empty declaration stays withheld.
    const names = resolveExposableEnvNames(env({ DISCORD_BOT_TOKEN: '', REAL: 'v' }))
    expect(names).toEqual(['REAL'])
  })

  test('exposes AGENT_MESSENGER_CONFIG_DIR pointing at the real cred dir (the original bug)', () => {
    const names = resolveExposableEnvNames(
      env({ AGENT_MESSENGER_CONFIG_DIR: '/agent/workspace/.config/agent-messenger' }),
    )
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR'])
  })
})
