import { describe, expect, test } from 'bun:test'

import { parseSecretsFile, SECRETS_FILE_VERSION } from './schema'

describe('parseSecretsFile (v2 envelope)', () => {
  test('accepts string-shorthand Secret for api-key key', () => {
    const result = parseSecretsFile({
      version: 2,
      providers: { openai: { type: 'api_key', key: 'sk-test' } },
      channels: {},
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(SECRETS_FILE_VERSION)
    expect(result.file.providers).toEqual({ openai: { type: 'api_key', key: { value: 'sk-test' } } })
    expect(result.file.channels).toEqual({})
  })

  test('accepts object Secret with value + env on api-key key', () => {
    const result = parseSecretsFile({
      version: 2,
      providers: { fireworks: { type: 'api_key', key: { value: 'fw_x', env: 'CUSTOM_FW_KEY' } } },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.providers.fireworks).toEqual({
      type: 'api_key',
      key: { value: 'fw_x', env: 'CUSTOM_FW_KEY' },
    })
  })

  test('accepts $schema + missing optional sections', () => {
    const result = parseSecretsFile({
      $schema: './node_modules/typeclaw/secrets.schema.json',
      version: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.providers).toEqual({})
    expect(result.file.channels).toEqual({})
  })

  test('accepts per-adapter channel fields with mixed Secret shapes', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        'slack-bot': { botToken: 'xoxb-a', appToken: { value: 'xapp-b', env: 'SLACK_APP_TOKEN' } },
        'discord-bot': { token: { env: 'CUSTOM_DISCORD' } },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-a' },
      appToken: { value: 'xapp-b', env: 'SLACK_APP_TOKEN' },
    })
    expect(result.file.channels['discord-bot']).toEqual({ token: { env: 'CUSTOM_DISCORD' } })
  })

  test('preserves passthrough fields on OAuth credentials so upstream additions survive', () => {
    const result = parseSecretsFile({
      version: 2,
      providers: {
        'openai-codex': {
          type: 'oauth',
          access: 'a',
          refresh: 'r',
          expires: 99,
          someFutureUpstreamField: 'preserved',
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cred = result.file.providers['openai-codex']
    expect(cred).toBeDefined()
    if (cred?.type !== 'oauth') throw new Error('expected oauth credential')
    expect(cred['someFutureUpstreamField']).toBe('preserved')
  })

  test('rejects empty-object Secret on api-key key', () => {
    const result = parseSecretsFile({
      version: 2,
      providers: { openai: { type: 'api_key', key: {} } },
    })

    expect(result.ok).toBe(false)
  })

  test('rejects non-object input', () => {
    const result = parseSecretsFile('not a record')
    expect(result.ok).toBe(false)
  })

  test('rejects array input', () => {
    const result = parseSecretsFile([])
    expect(result.ok).toBe(false)
  })

  test('rejects unknown discriminator on legacy credential', () => {
    const result = parseSecretsFile({ openai: { type: 'totally_made_up', key: 'x' } })
    expect(result.ok).toBe(false)
  })
})

describe('parseSecretsFile (v1 legacy upgrade)', () => {
  test('upgrades v1 envelope: llm -> providers with Secret-wrapped api-key', () => {
    const result = parseSecretsFile({
      version: 1,
      llm: {
        openai: { type: 'api_key', key: 'sk-old' },
        'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
      },
      channels: {},
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(SECRETS_FILE_VERSION)
    expect(result.file.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-old' } })
    expect(result.file.providers['openai-codex']?.type).toBe('oauth')
    expect(result.file.channels).toEqual({})
  })

  test('upgrades v1 channels: env-var-keyed -> field-name-keyed Secret', () => {
    const result = parseSecretsFile({
      version: 1,
      llm: {},
      channels: {
        'discord-bot': { DISCORD_BOT_TOKEN: 'd-tok' },
        'slack-bot': { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
        'telegram-bot': { TELEGRAM_BOT_TOKEN: '123:tg' },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.channels['discord-bot']).toEqual({ token: { value: 'd-tok' } })
    expect(result.file.channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-a' },
      appToken: { value: 'xapp-b' },
    })
    expect(result.file.channels['telegram-bot']).toEqual({ token: { value: '123:tg' } })
  })

  test('upgrades v1 with $schema preserved', () => {
    const result = parseSecretsFile({
      $schema: './node_modules/typeclaw/secrets.schema.json',
      version: 1,
      llm: {},
      channels: {},
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.$schema).toBe('./node_modules/typeclaw/secrets.schema.json')
    expect(result.file.version).toBe(SECRETS_FILE_VERSION)
  })

  test('passes through unknown adapter ids in v1 channels under verbatim env-var keys', () => {
    const result = parseSecretsFile({
      version: 1,
      llm: {},
      channels: {
        'future-plugin-adapter': { CUSTOM_TOKEN: 'pt-x' },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.channels['future-plugin-adapter']).toEqual({ CUSTOM_TOKEN: { value: 'pt-x' } })
  })

  test('upgrades pre-envelope flat shape (very legacy)', () => {
    const result = parseSecretsFile({
      openai: { type: 'api_key', key: 'sk-test' },
      'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(SECRETS_FILE_VERSION)
    expect(result.file.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-test' } })
    expect(result.file.providers['openai-codex']?.type).toBe('oauth')
    expect(result.file.channels).toEqual({})
  })

  test('upgrades empty object as legacy-empty (freshly created secrets file)', () => {
    const result = parseSecretsFile({})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toEqual({ version: SECRETS_FILE_VERSION, providers: {}, channels: {} })
  })

  test('rejects malformed api-key in legacy flat shape (missing key)', () => {
    const result = parseSecretsFile({ openai: { type: 'api_key' } })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('version')
  })
})
