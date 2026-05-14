import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AddChannelStepEvent, readConfiguredChannels, runAddChannel, scaffold, writeSecrets } from './index'
import { runKakaotalkBootstrap } from './kakaotalk-auth'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-add-channel-'))
  await scaffold(root)
  await writeSecrets(root, { apiKey: 'fw_existing', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readConfig(): Promise<{ channels?: Record<string, { allow: string[] }>; [k: string]: unknown }> {
  return JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
    channels?: Record<string, { allow: string[] }>
  }
}

async function readSecrets(): Promise<{
  providers?: Record<string, unknown>
  channels?: Record<string, Record<string, unknown>>
}> {
  try {
    const raw = await readFile(join(root, 'secrets.json'), 'utf8')
    return JSON.parse(raw) as {
      providers?: Record<string, unknown>
      channels?: Record<string, Record<string, unknown>>
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function readSecretsChannels(): Promise<Record<string, Record<string, unknown>>> {
  return (await readSecrets()).channels ?? {}
}

describe('runAddChannel', () => {
  test('adds discord-bot to typeclaw.json with allow=["*"] by default', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-token-x' })

    const cfg = await readConfig()
    expect(cfg.channels?.['discord-bot']?.allow).toEqual(['*'])
  })

  test('adds discord-bot with allow=[] when allowAll=false', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'discord-bot',
      discordBotToken: 'discord-token-x',
      allowAll: false,
    })

    const cfg = await readConfig()
    expect(cfg.channels?.['discord-bot']?.allow).toEqual([])
  })

  test('saves discord-bot.token to secrets.json#channels without disturbing the Fireworks provider key', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-token-x' })

    const secrets = await readSecrets()
    expect(secrets.providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-token-x' } })
  })

  test('adds slack-bot with both bot+app tokens to secrets.json#channels.slack-bot', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-bot',
      slackAppToken: 'xapp-app',
    })

    const cfg = await readConfig()
    expect(cfg.channels?.['slack-bot']?.allow).toEqual(['*'])
    const channels = await readSecretsChannels()
    expect(channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-bot' },
      appToken: { value: 'xapp-app' },
    })
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds telegram-bot config + secrets.json#channels.telegram-bot', async () => {
    await runAddChannel({ cwd: root, channel: 'telegram-bot', telegramBotToken: '123:tg-secret' })

    const cfg = await readConfig()
    expect(cfg.channels?.['telegram-bot']?.allow).toEqual(['*'])
    const channels = await readSecretsChannels()
    expect(channels['telegram-bot']).toEqual({ token: { value: '123:tg-secret' } })
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds kakaotalk with kakao:dm/* allow by default and runs auth runner', async () => {
    const authCalls: string[] = []
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async ({ cwd }) => {
        authCalls.push(cwd)
        return { ok: true }
      },
    })

    expect(authCalls).toEqual([root])
    const cfg = await readConfig()
    expect(cfg.channels?.kakaotalk?.allow).toEqual(['kakao:dm/*'])
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds kakaotalk credentials to secrets.json instead of workspace credential files', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async ({ cwd }) =>
        runKakaotalkBootstrap({
          email: 'user@example.com',
          password: 'secret',
          agentDir: cwd,
          callbacks: { onPasscode: () => {} },
          loginFlow: async () => ({
            authenticated: true,
            credentials: {
              access_token: 'oauth-abc',
              refresh_token: 'refresh-xyz',
              user_id: 'user-1',
              device_uuid: 'uuid-1',
              device_type: 'tablet',
            },
          }),
        }),
    })

    const channels = await readSecretsChannels()
    const kakao = channels.kakaotalk as unknown as {
      currentAccount: string
      accounts: Record<string, { oauth_token: string }>
    }
    expect(kakao.currentAccount).toBe('user-1')
    expect(kakao.accounts['user-1']?.oauth_token).toBe('oauth-abc')
    expect(existsSync(join(root, 'workspace', '.agent-messenger', 'kakaotalk-credentials.json'))).toBe(false)
  })

  test('kakaotalk with allowAll=true broadens allow to kakao:*', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async () => ({ ok: true }),
      allowAll: true,
    })

    const cfg = await readConfig()
    expect(cfg.channels?.kakaotalk?.allow).toEqual(['kakao:*'])
  })

  test('aborts and leaves typeclaw.json + secrets.json untouched when kakaotalk auth fails', async () => {
    const beforeConfig = await readFile(join(root, 'typeclaw.json'), 'utf8')
    const beforeSecrets = await readFile(join(root, 'secrets.json'), 'utf8')

    await expect(
      runAddChannel({
        cwd: root,
        channel: 'kakaotalk',
        runKakaotalkAuth: async () => ({ ok: false, reason: 'bad password' }),
      }),
    ).rejects.toThrow(/bad password/)

    expect(await readFile(join(root, 'typeclaw.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(beforeSecrets)
  })

  test('preserves an existing channel when adding a different one', async () => {
    await runAddChannel({ cwd: root, channel: 'slack-bot', slackBotToken: 'xoxb-x', slackAppToken: 'xapp-x' })
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const cfg = await readConfig()
    expect(cfg.channels?.['slack-bot']?.allow).toEqual(['*'])
    expect(cfg.channels?.['discord-bot']?.allow).toEqual(['*'])
    const channels = await readSecretsChannels()
    expect(channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-x' },
      appToken: { value: 'xapp-x' },
    })
    expect(channels['discord-bot']).toEqual({ token: { value: 'discord-x' } })
  })

  test('preserves arbitrary unrelated keys in typeclaw.json (does not strip user fields)', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    cfg.mounts = [{ source: '~/data', target: '/data' }]
    cfg.idleMs = 60_000
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(cfg, null, 2)}\n`)

    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const after = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    expect(after.mounts).toEqual([{ source: '~/data', target: '/data' }])
    expect(after.idleMs).toBe(60_000)
  })

  test('rejects re-adding an already-configured channel', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-first' })

    await expect(
      runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-second' }),
    ).rejects.toThrow(/already configured/i)

    const channels = await readSecretsChannels()
    expect(channels['discord-bot']).toEqual({ token: { value: 'discord-first' } })
  })

  test('rejects when a field the channel needs already exists in secrets.json (does not overwrite user secrets)', async () => {
    await writeFile(
      join(root, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {},
        channels: { 'discord-bot': { token: { value: 'keep-me' } } },
      }),
    )

    await expect(runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'overwrite-me' })).rejects.toThrow(
      /token/,
    )

    const channels = await readSecretsChannels()
    expect(channels['discord-bot']).toEqual({ token: { value: 'keep-me' } })
  })

  test('throws a helpful error when run from a non-initialized directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-add-empty-'))
    try {
      await expect(runAddChannel({ cwd: empty, channel: 'discord-bot', discordBotToken: 'x' })).rejects.toThrow(
        /typeclaw\.json not found/,
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('emits config + secrets events in order for a non-kakaotalk channel', async () => {
    const events: AddChannelStepEvent[] = []
    await runAddChannel({
      cwd: root,
      channel: 'telegram-bot',
      telegramBotToken: '123:t',
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
    ])
  })

  test('emits kakaotalk-auth before config + secrets when adding kakaotalk', async () => {
    const events: AddChannelStepEvent[] = []
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async () => ({ ok: true }),
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'kakaotalk-auth:start',
      'kakaotalk-auth:done',
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
    ])
  })
})

describe('readConfiguredChannels', () => {
  test('returns empty set when no channels are configured', async () => {
    const present = await readConfiguredChannels(root)
    expect(present.size).toBe(0)
  })

  test('returns the set of configured channel keys', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'd' })
    await runAddChannel({ cwd: root, channel: 'telegram-bot', telegramBotToken: '1:t' })

    const present = await readConfiguredChannels(root)
    expect([...present].sort()).toEqual(['discord-bot', 'telegram-bot'])
  })

  test('returns empty set when typeclaw.json is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-add-noconfig-'))
    try {
      const present = await readConfiguredChannels(empty)
      expect(present.size).toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
