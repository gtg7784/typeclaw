import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hydrateChannelEnvFromSecrets } from './hydrate'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'typeclaw-hydrate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSecrets(file: {
  channels?: Record<string, Record<string, string>>
  llm?: Record<string, unknown>
}): void {
  writeFileSync(
    join(root, 'secrets.json'),
    JSON.stringify({ version: 1, llm: file.llm ?? {}, channels: file.channels ?? {} }),
  )
}

describe('hydrateChannelEnvFromSecrets', () => {
  test('copies each (key, value) pair from every adapter slot into env', () => {
    writeSecrets({
      channels: {
        'discord-bot': { DISCORD_BOT_TOKEN: 'd-tok' },
        'slack-bot': { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      },
    })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('d-tok')
    expect(env['SLACK_BOT_TOKEN']).toBe('xoxb-a')
    expect(env['SLACK_APP_TOKEN']).toBe('xapp-b')
    expect(result.applied.sort()).toEqual(['DISCORD_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  })

  test('does not overwrite a key already set in env (--env-file wins)', () => {
    writeSecrets({ channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'from-secrets' } } })
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'from-env-file' }

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('from-env-file')
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual(['DISCORD_BOT_TOKEN'])
  })

  test('strips applied keys from .env to make secrets.json the single source of truth', () => {
    writeSecrets({ channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd-tok' } } })
    writeFileSync(join(root, '.env'), 'FIREWORKS_API_KEY=keep\nDISCORD_BOT_TOKEN=stale\n')
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=keep\n')
  })

  test('does not strip keys that were skipped because env already had them', () => {
    writeSecrets({ channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd-tok' } } })
    writeFileSync(join(root, '.env'), 'DISCORD_BOT_TOKEN=in-env\n')
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'in-env' }

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('DISCORD_BOT_TOKEN=in-env\n')
  })

  test('returns empty result when secrets.json does not exist', () => {
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(result.applied).toEqual([])
    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined()
  })

  test('returns empty result when secrets.json#channels is empty', () => {
    writeSecrets({ channels: {} })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(result.applied).toEqual([])
  })

  test('ignores malformed secrets.json rather than throwing', () => {
    writeFileSync(join(root, 'secrets.json'), '{ not json')
    const env: NodeJS.ProcessEnv = {}

    expect(() => hydrateChannelEnvFromSecrets({ agentDir: root, env })).not.toThrow()
  })

  test('mutation check: commenting out the env[key] = value line leaves env empty', () => {
    // Acceptance bar from AGENTS.md §3: if the assignment line is removed,
    // this test must fail because env stays empty even though applied is
    // populated.
    writeSecrets({ channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'd-tok' } } })
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('d-tok')
  })
})
