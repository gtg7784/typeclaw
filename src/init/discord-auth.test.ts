import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsDiscordCredentialStore } from '@/secrets/discord-store'

import { discordSecretsPath, runDiscordBootstrap } from './discord-auth'

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-discord-auth-'))

describe('runDiscordBootstrap', () => {
  test('logs in with remote auth and writes discord account secrets', async () => {
    const dir = await tmp()
    const qrUrls: string[] = []
    try {
      const result = await runDiscordBootstrap({
        agentDir: dir,
        onQrUrl: (url) => {
          qrUrls.push(url)
        },
        loginWithRemoteAuth: async (options) => {
          await options?.onQrUrl?.('https://discord.com/ra/test')
          return {
            token: 'discord-token-test',
            user: { id: '100000000000000001', username: 'alice', discriminator: '0', avatar: null },
          }
        },
      })

      expect(result).toEqual({ ok: true })
      expect(qrUrls).toEqual(['https://discord.com/ra/test'])
      expect(discordSecretsPath(dir)).toBe(join(dir, 'secrets.json'))
      const store = new SecretsDiscordCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      const account = await store.getAccount()
      expect(account?.token).toBe('discord-token-test')
      expect(account?.username).toBe('alice')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns a failure result when remote auth throws', async () => {
    const dir = await tmp()
    try {
      const result = await runDiscordBootstrap({
        agentDir: dir,
        loginWithRemoteAuth: async () => {
          throw new Error('remote auth failed')
        },
      })

      expect(result).toEqual({ ok: false, reason: 'remote auth failed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
