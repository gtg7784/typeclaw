import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readGithubAuthType, runAddChannel, scaffold, setChannelSecrets, setGithubSecrets, writeSecrets } from './index'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-set-channel-'))
  await scaffold(root)
  await writeSecrets(root, { apiKey: 'fw_existing', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readSecrets(): Promise<{
  providers?: Record<string, unknown>
  channels?: Record<string, Record<string, unknown>>
}> {
  const raw = await readFile(join(root, 'secrets.json'), 'utf8')
  return JSON.parse(raw) as { providers?: Record<string, unknown>; channels?: Record<string, Record<string, unknown>> }
}

describe('setChannelSecrets', () => {
  test('rotates discord-bot token in place', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'old-discord' })

    const result = await setChannelSecrets(root, 'discord-bot', { token: 'new-discord' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'new-discord' } })
  })

  test('rotates only the slack token fields it is given, preserving the others', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-old',
      slackAppToken: 'xapp-old',
    })

    const result = await setChannelSecrets(root, 'slack-bot', { botToken: 'xoxb-new' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-new' },
      appToken: { value: 'xapp-old' },
    })
  })

  test('rotates both slack tokens at once when both are passed', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-old',
      slackAppToken: 'xapp-old',
    })

    const result = await setChannelSecrets(root, 'slack-bot', { botToken: 'xoxb-new', appToken: 'xapp-new' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-new' },
      appToken: { value: 'xapp-new' },
    })
  })

  test('rotates telegram-bot token in place', async () => {
    await runAddChannel({ cwd: root, channel: 'telegram-bot', telegramBotToken: '111:old' })

    const result = await setChannelSecrets(root, 'telegram-bot', { token: '222:new' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['telegram-bot']).toEqual({ token: { value: '222:new' } })
  })

  test('refuses to rotate a channel that was never added', async () => {
    const result = await setChannelSecrets(root, 'discord-bot', { token: 'new' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not configured/i)
    expect(result.reason).toMatch(/channel add discord-bot/)
  })

  test('preserves provider credentials and other channels when rotating one channel', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'old-discord' })
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-keep',
      slackAppToken: 'xapp-keep',
    })

    await setChannelSecrets(root, 'discord-bot', { token: 'rotated' })

    const secrets = await readSecrets()
    expect(secrets.providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-keep' },
      appToken: { value: 'xapp-keep' },
    })
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'rotated' } })
  })

  test('preserves a user-authored {env} rebinding on a sibling field', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-orig',
      slackAppToken: 'xapp-orig',
    })

    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels['slack-bot'] = {
      botToken: { value: 'xoxb-orig' },
      appToken: { env: 'CUSTOM_SLACK_APP_TOKEN' },
    }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setChannelSecrets(root, 'slack-bot', { botToken: 'xoxb-rotated' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-rotated' },
      appToken: { env: 'CUSTOM_SLACK_APP_TOKEN' },
    })
  })

  test('preserves an env-binding on the rotated field itself (env-wins still works after rotation)', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'value-x' })
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels['discord-bot'] = { token: { env: 'CUSTOM_DISCORD_TOKEN' } }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setChannelSecrets(root, 'discord-bot', { token: 'rotated-value' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['discord-bot']).toEqual({
      token: { value: 'rotated-value', env: 'CUSTOM_DISCORD_TOKEN' },
    })
  })

  test('preserves an env-binding when the rotated field had both value and env on disk', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'value-x' })
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels['discord-bot'] = { token: { value: 'old-value', env: 'CUSTOM_DISCORD_TOKEN' } }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setChannelSecrets(root, 'discord-bot', { token: 'rotated-value' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['discord-bot']).toEqual({
      token: { value: 'rotated-value', env: 'CUSTOM_DISCORD_TOKEN' },
    })
  })

  test('refuses to rotate slack-bot if the resulting slot would be missing a required field', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-orig',
      slackAppToken: 'xapp-orig',
    })
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels['slack-bot'] = { botToken: { value: 'xoxb-orig' } }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setChannelSecrets(root, 'slack-bot', { botToken: 'xoxb-rotated' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/half-configured/i)
    expect(result.reason).toMatch(/appToken/)
    const secrets = await readSecrets()
    expect(secrets.channels?.['slack-bot']).toEqual({ botToken: { value: 'xoxb-orig' } })
  })

  test('allows rotating both slack tokens at once when disk was empty (full repair)', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-orig',
      slackAppToken: 'xapp-orig',
    })
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels['slack-bot'] = {}
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setChannelSecrets(root, 'slack-bot', { botToken: 'xoxb-new', appToken: 'xapp-new' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-new' },
      appToken: { value: 'xapp-new' },
    })
  })

  test('no-op when called with an empty tokens map', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'unchanged' })
    const before = await readFile(join(root, 'secrets.json'), 'utf8')

    const result = await setChannelSecrets(root, 'discord-bot', {})

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(before)
  })

  test('returns the same structured error for non-agent directory regardless of patch shape', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-set-empty-'))
    try {
      const withPatch = await setChannelSecrets(empty, 'discord-bot', { token: 'x' })
      const withoutPatch = await setChannelSecrets(empty, 'discord-bot', {})

      expect(withPatch.ok).toBe(false)
      expect(withoutPatch.ok).toBe(false)
      if (withPatch.ok || withoutPatch.ok) throw new Error('unreachable')
      expect(withPatch.reason).toMatch(/typeclaw\.json not found/)
      expect(withoutPatch.reason).toMatch(/typeclaw\.json not found/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('returns a structured error when secrets.json is malformed (does not throw)', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'orig' })
    await writeFile(join(root, 'secrets.json'), '{ this is not valid JSON')

    const result = await setChannelSecrets(root, 'discord-bot', { token: 'rotated' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/secrets\.json is malformed/i)
  })
})

describe('setGithubSecrets', () => {
  async function seedPatGithub(): Promise<void> {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      webhookSecret: 'wh-old',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/test-repo'],
      auth: { type: 'pat', pat: 'ghp_old' },
    })
  }

  async function seedAppGithub(): Promise<void> {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      webhookSecret: 'wh-old',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/test-repo'],
      auth: {
        type: 'app',
        appId: 1234,
        privateKey: '-----BEGIN PRIVATE KEY-----\nold-key\n-----END PRIVATE KEY-----',
        installationId: 9999,
      },
    })
  }

  test('rotates only the webhook secret when auth is omitted', async () => {
    await seedPatGithub()

    const result = await setGithubSecrets(root, { webhookSecret: 'wh-new' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({ type: 'pat', token: { value: 'ghp_old' } })
    expect(gh.webhookSecret).toEqual({ value: 'wh-new' })
  })

  test('rotates only the PAT when webhookSecret is omitted', async () => {
    await seedPatGithub()

    const result = await setGithubSecrets(root, { auth: { type: 'pat', pat: 'ghp_new' } })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({ type: 'pat', token: { value: 'ghp_new' } })
    expect(gh.webhookSecret).toEqual({ value: 'wh-old' })
  })

  test('rotates the App private key while preserving appId and installationId from disk', async () => {
    await seedAppGithub()

    const result = await setGithubSecrets(root, {
      auth: { type: 'app', privateKey: '-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----' },
    })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({
      type: 'app',
      appId: 1234,
      privateKey: { value: '-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----' },
      installationId: 9999,
    })
  })

  test('rotates both webhook and auth when both are passed', async () => {
    await seedPatGithub()

    const result = await setGithubSecrets(root, {
      webhookSecret: 'wh-new',
      auth: { type: 'pat', pat: 'ghp_new' },
    })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({ type: 'pat', token: { value: 'ghp_new' } })
    expect(gh.webhookSecret).toEqual({ value: 'wh-new' })
  })

  test('refuses to flip auth from pat to app', async () => {
    await seedPatGithub()

    const result = await setGithubSecrets(root, {
      auth: { type: 'app', privateKey: 'whatever' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/auth type mismatch/i)
    expect(result.reason).toMatch(/pat/)
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({ type: 'pat', token: { value: 'ghp_old' } })
  })

  test('refuses to flip auth from app to pat', async () => {
    await seedAppGithub()

    const result = await setGithubSecrets(root, {
      auth: { type: 'pat', pat: 'ghp_whatever' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/auth type mismatch/i)
  })

  test('refuses to rotate github when secrets.json has no github entry', async () => {
    const result = await setGithubSecrets(root, { webhookSecret: 'wh-new' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not configured/i)
    expect(result.reason).toMatch(/channel add github/)
  })

  test('no-op when called with an empty patch', async () => {
    await seedPatGithub()
    const before = await readFile(join(root, 'secrets.json'), 'utf8')

    const result = await setGithubSecrets(root, {})

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(before)
  })

  test('preserves other channels and provider credentials when rotating github', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-keep' })
    await seedPatGithub()

    await setGithubSecrets(root, { webhookSecret: 'wh-rotated', auth: { type: 'pat', pat: 'ghp_rotated' } })

    const secrets = await readSecrets()
    expect(secrets.providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-keep' } })
  })

  test('preserves env-binding on rotated PAT', async () => {
    await seedPatGithub()
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels.github = {
      auth: { type: 'pat', token: { value: 'ghp_old', env: 'CUSTOM_GH_PAT' } },
      webhookSecret: { value: 'wh-old' },
    }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setGithubSecrets(root, { auth: { type: 'pat', pat: 'ghp_rotated' } })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({ type: 'pat', token: { value: 'ghp_rotated', env: 'CUSTOM_GH_PAT' } })
  })

  test('preserves env-binding on rotated App private key', async () => {
    await seedAppGithub()
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels.github = {
      auth: {
        type: 'app',
        appId: 1234,
        privateKey: { value: '-----BEGIN PRIVATE KEY-----\nold\n-----END PRIVATE KEY-----', env: 'CUSTOM_GH_APP_KEY' },
        installationId: 9999,
      },
      webhookSecret: { value: 'wh-old' },
    }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setGithubSecrets(root, {
      auth: { type: 'app', privateKey: '-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----' },
    })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.auth).toEqual({
      type: 'app',
      appId: 1234,
      privateKey: {
        value: '-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----',
        env: 'CUSTOM_GH_APP_KEY',
      },
      installationId: 9999,
    })
  })

  test('preserves env-binding on rotated webhook secret', async () => {
    await seedPatGithub()
    const raw = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
      channels: Record<string, Record<string, unknown>>
    }
    raw.channels.github = {
      auth: { type: 'pat', token: { value: 'ghp_old' } },
      webhookSecret: { env: 'CUSTOM_GH_WEBHOOK' },
    }
    await writeFile(join(root, 'secrets.json'), JSON.stringify(raw, null, 2))

    const result = await setGithubSecrets(root, { webhookSecret: 'wh-rotated' })

    expect(result).toEqual({ ok: true })
    const secrets = await readSecrets()
    const gh = secrets.channels?.github as Record<string, unknown>
    expect(gh.webhookSecret).toEqual({ value: 'wh-rotated', env: 'CUSTOM_GH_WEBHOOK' })
  })

  test('returns a structured error when secrets.json is malformed (does not throw)', async () => {
    await seedPatGithub()
    await writeFile(join(root, 'secrets.json'), '{ malformed')

    const result = await setGithubSecrets(root, { webhookSecret: 'wh-new' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/secrets\.json is malformed/i)
  })

  test('returns the same error for non-agent directory regardless of patch shape', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-set-empty-gh-'))
    try {
      const withPatch = await setGithubSecrets(empty, { webhookSecret: 'wh' })
      const emptyPatch = await setGithubSecrets(empty, {})

      expect(withPatch.ok).toBe(false)
      expect(emptyPatch.ok).toBe(false)
      if (withPatch.ok || emptyPatch.ok) throw new Error('unreachable')
      expect(withPatch.reason).toMatch(/typeclaw\.json not found/)
      expect(emptyPatch.reason).toMatch(/typeclaw\.json not found/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('readGithubAuthType', () => {
  test('returns "pat" when github is configured with PAT auth', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      webhookSecret: 'wh',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/r'],
      auth: { type: 'pat', pat: 'ghp_x' },
    })

    expect(readGithubAuthType(root)).toBe('pat')
  })

  test('returns "app" when github is configured with App auth', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      webhookSecret: 'wh',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/r'],
      auth: {
        type: 'app',
        appId: 42,
        privateKey: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----',
      },
    })

    expect(readGithubAuthType(root)).toBe('app')
  })

  test('returns null when github is not configured', () => {
    expect(readGithubAuthType(root)).toBeNull()
  })

  test('returns null when secrets.json is malformed (no throw)', async () => {
    await writeFile(join(root, 'secrets.json'), '{ malformed')
    expect(readGithubAuthType(root)).toBeNull()
  })
})
