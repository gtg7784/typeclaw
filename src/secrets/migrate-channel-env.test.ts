import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { promoteChannelEnvIntoSecrets } from './migrate-channel-env'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'typeclaw-promote-channels-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function readChannels(): Record<string, Record<string, string>> {
  const raw = readFileSync(join(root, 'secrets.json'), 'utf8')
  const parsed = JSON.parse(raw) as { channels?: Record<string, Record<string, string>> }
  return parsed.channels ?? {}
}

describe('promoteChannelEnvIntoSecrets', () => {
  test('copies every channel env var into the matching secrets.json adapter slot', () => {
    const env: NodeJS.ProcessEnv = {
      DISCORD_BOT_TOKEN: 'd-tok',
      SLACK_BOT_TOKEN: 'xoxb-a',
      SLACK_APP_TOKEN: 'xapp-b',
      TELEGRAM_BOT_TOKEN: '123:tg',
    }

    const result = promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(result.promoted['discord-bot']).toEqual(['DISCORD_BOT_TOKEN'])
    expect(result.promoted['slack-bot']?.sort()).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
    expect(result.promoted['telegram-bot']).toEqual(['TELEGRAM_BOT_TOKEN'])

    const channels = readChannels()
    expect(channels['discord-bot']).toEqual({ DISCORD_BOT_TOKEN: 'd-tok' })
    expect(channels['slack-bot']).toEqual({ SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' })
    expect(channels['telegram-bot']).toEqual({ TELEGRAM_BOT_TOKEN: '123:tg' })
  })

  test('does not write secrets.json when no channel env vars are set', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-x' }

    const result = promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(result.promoted).toEqual({})
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  test('is idempotent: running twice produces the same secrets.json', () => {
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })
    const first = readFileSync(join(root, 'secrets.json'), 'utf8')

    const second = promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(second.promoted).toEqual({})
    expect(readFileSync(join(root, 'secrets.json'), 'utf8')).toBe(first)
  })

  test('does not displace an existing value in the slot (manual edits win)', () => {
    writeFileSync(
      join(root, 'secrets.json'),
      JSON.stringify({
        version: 1,
        llm: {},
        channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'manually-set' } },
      }),
    )
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'from-env' }

    const result = promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(result.promoted).toEqual({})
    expect(readChannels()['discord-bot']).toEqual({ DISCORD_BOT_TOKEN: 'manually-set' })
  })

  test('preserves an existing OAuth credential in the llm slice', () => {
    writeFileSync(
      join(root, 'secrets.json'),
      JSON.stringify({
        version: 1,
        llm: { 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } },
        channels: {},
      }),
    )
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    const raw = readFileSync(join(root, 'secrets.json'), 'utf8')
    const parsed = JSON.parse(raw) as { llm: Record<string, { type: string }> }
    expect(parsed.llm['openai-codex']?.type).toBe('oauth')
  })

  test('mutation check: removing the writeChannelsSync call leaves secrets.json empty', () => {
    // Acceptance bar from AGENTS.md §3: this test fails the moment the
    // backend.writeChannelsSync call is commented out, because the file
    // never gets the promoted values written through.
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(readChannels()['discord-bot']).toEqual({ DISCORD_BOT_TOKEN: 'd-tok' })
  })

  test('removes every promoted key from .env, preserving other lines and comments', () => {
    writeFileSync(
      join(root, '.env'),
      [
        '# user secrets',
        'OPENAI_API_KEY=sk-keep',
        'DISCORD_BOT_TOKEN=d-tok',
        'SLACK_BOT_TOKEN=xoxb-a',
        'SLACK_APP_TOKEN=xapp-b',
        'UNRELATED=keep-me',
        '',
      ].join('\n'),
    )
    const env: NodeJS.ProcessEnv = {
      DISCORD_BOT_TOKEN: 'd-tok',
      SLACK_BOT_TOKEN: 'xoxb-a',
      SLACK_APP_TOKEN: 'xapp-b',
    }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    const envText = readFileSync(join(root, '.env'), 'utf8')
    expect(envText).not.toContain('DISCORD_BOT_TOKEN')
    expect(envText).not.toContain('SLACK_BOT_TOKEN')
    expect(envText).not.toContain('SLACK_APP_TOKEN')
    expect(envText).toContain('# user secrets')
    expect(envText).toContain('OPENAI_API_KEY=sk-keep')
    expect(envText).toContain('UNRELATED=keep-me')
  })

  test('does not touch .env when the slot was already populated (no promotion = no strip)', () => {
    writeFileSync(
      join(root, 'secrets.json'),
      JSON.stringify({
        version: 1,
        llm: {},
        channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'manually-set' } },
      }),
    )
    const original = 'DISCORD_BOT_TOKEN=from-env\n'
    writeFileSync(join(root, '.env'), original)
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'from-env' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original)
  })

  test('is a no-op on .env when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(readChannels()['discord-bot']).toEqual({ DISCORD_BOT_TOKEN: 'd-tok' })
  })

  test('mutation check: removing the stripEnvKey loop leaves .env unchanged', () => {
    // Acceptance bar from AGENTS.md §3: commenting out the strip loop fails
    // this test because the migrated key would still be sitting in .env.
    writeFileSync(join(root, '.env'), 'DISCORD_BOT_TOKEN=d-tok\n')
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }

    promoteChannelEnvIntoSecrets({ agentDir: root, env })

    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DISCORD_BOT_TOKEN')
  })
})
