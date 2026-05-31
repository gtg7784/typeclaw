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

  test('migrates legacy github App auth by stripping the removed installationId field', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        github: {
          auth: { type: 'app', appId: 123, privateKey: { value: 'pk' }, installationId: 9999 },
          webhookSecret: { value: 'wh' },
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const github = result.file.channels.github as { auth: Record<string, unknown> }
    expect(github.auth).toEqual({ type: 'app', appId: 123, privateKey: { value: 'pk' } })
    expect('installationId' in github.auth).toBe(false)
  })

  test('accepts channels.kakaotalk credential block', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        kakaotalk: {
          currentAccount: 'user-1',
          accounts: {
            'user-1': {
              account_id: 'user-1',
              oauth_token: 'oauth-token',
              user_id: 'user-1',
              refresh_token: 'refresh-token',
              device_uuid: 'device-uuid',
              device_type: 'tablet',
              auth_method: 'login',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
          pendingLogin: {
            device_uuid: 'pending-device',
            device_type: 'tablet',
            email: 'user@example.com',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.channels.kakaotalk?.currentAccount).toBe('user-1')
    expect(result.file.channels.kakaotalk?.accounts['user-1']?.oauth_token).toBe('oauth-token')
    expect(result.file.channels.kakaotalk?.pendingLogin?.email).toBe('user@example.com')
  })

  test('accepts empty channels.kakaotalk block', () => {
    const result = parseSecretsFile({ version: 2, channels: { kakaotalk: { currentAccount: null, accounts: {} } } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.channels.kakaotalk).toEqual({ currentAccount: null, accounts: {} })
  })

  test('accepts a kakaotalk account with renewal fields (email + encryptedPassword)', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        kakaotalk: {
          currentAccount: 'user-1',
          accounts: {
            'user-1': {
              account_id: 'user-1',
              oauth_token: 'oauth-token',
              user_id: 'user-1',
              device_uuid: 'device-uuid',
              device_type: 'tablet',
              auth_method: 'login',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              email: 'user@example.com',
              encryptedPassword: {
                v: 1,
                alg: 'AES-256-GCM',
                kid: 'sha256:0123456789abcdef',
                iv: 'aXY=',
                ciphertext: 'Y3Q=',
                authTag: 'YXQ=',
                createdAt: '2026-05-14T00:00:00.000Z',
              },
            },
          },
        },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const account = result.file.channels.kakaotalk?.accounts['user-1']
    expect(account?.email).toBe('user@example.com')
    expect(account?.encryptedPassword?.v).toBe(1)
    expect(account?.encryptedPassword?.alg).toBe('AES-256-GCM')
    expect(account?.encryptedPassword?.kid).toBe('sha256:0123456789abcdef')
  })

  test('rejects a kakaotalk encryptedPassword envelope with unknown extra fields (strict schema)', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        kakaotalk: {
          currentAccount: 'user-1',
          accounts: {
            'user-1': {
              account_id: 'user-1',
              oauth_token: 'o',
              user_id: 'user-1',
              device_uuid: 'd',
              device_type: 'tablet',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              encryptedPassword: {
                v: 1,
                alg: 'AES-256-GCM',
                kid: 'sha256:0123456789abcdef',
                iv: 'a',
                ciphertext: 'b',
                authTag: 'c',
                createdAt: '2026-05-14T00:00:00.000Z',
                rogue: 'forward-compat-violation',
              },
            },
          },
        },
      },
    })

    expect(result.ok).toBe(false)
  })

  test('rejects a kakaotalk encryptedPassword envelope with wrong algorithm', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        kakaotalk: {
          currentAccount: 'user-1',
          accounts: {
            'user-1': {
              account_id: 'user-1',
              oauth_token: 'o',
              user_id: 'user-1',
              device_uuid: 'd',
              device_type: 'tablet',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              encryptedPassword: {
                v: 1,
                alg: 'AES-128-GCM',
                kid: 'sha256:0123456789abcdef',
                iv: 'a',
                ciphertext: 'b',
                authTag: 'c',
                createdAt: '2026-05-14T00:00:00.000Z',
              },
            },
          },
        },
      },
    })

    expect(result.ok).toBe(false)
  })

  test('rejects malformed channels.kakaotalk account block', () => {
    const result = parseSecretsFile({
      version: 2,
      channels: {
        kakaotalk: {
          currentAccount: 'user-1',
          accounts: {
            'user-1': { account_id: 'user-1', oauth_token: 'oauth-token' },
          },
        },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('channels.kakaotalk.accounts.user-1.user_id')
  })

  test('upgrades legacy flat shape with at least one credential', () => {
    const result = parseSecretsFile({
      openai: { type: 'api_key', key: 'sk-test' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(SECRETS_FILE_VERSION)
    expect(result.file.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-test' } })
    expect(result.file.channels).toEqual({})
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
