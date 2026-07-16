import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsSlackCredentialStore } from '@/secrets/slack-store'

import { runSlackBootstrap, runSlackConfirmationBootstrap, slackSecretsPath } from './slack-auth'

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-slack-auth-'))

describe('runSlackBootstrap', () => {
  test('logs in with QR data URL and writes slack account secrets', async () => {
    const dir = await tmp()
    try {
      const result = await runSlackBootstrap({
        agentDir: dir,
        qrDataUrl: 'data:image/png;base64,AAAA',
        loginWithQr: async () => ({ token: 'xoxc-test', cookie: 'xoxd-test', workspace: 'Acme' }),
      })

      expect(result).toEqual({ ok: true })
      expect(slackSecretsPath(dir)).toBe(join(dir, 'secrets.json'))
      const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      const account = await store.getAccount()
      expect(account?.token).toBe('xoxc-test')
      expect(account?.cookie).toBe('xoxd-test')
      expect(account?.workspace_name).toBe('Acme')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns a failure result when QR login throws', async () => {
    const dir = await tmp()
    try {
      const result = await runSlackBootstrap({
        agentDir: dir,
        qrDataUrl: 'data:image/png;base64,AAAA',
        loginWithQr: async () => {
          throw new Error('invalid qr')
        },
      })

      expect(result).toEqual({ ok: false, reason: 'invalid qr' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runSlackConfirmationBootstrap', () => {
  test('logs in with a confirmation code and writes slack account secrets', async () => {
    const dir = await tmp()
    try {
      let requestedCode = false
      const result = await runSlackConfirmationBootstrap({
        agentDir: dir,
        qrDataUrl: 'data:image/png;base64,AAAA',
        email: 'user@acme.com',
        requestCode: async () => {
          requestedCode = true
          return '123456'
        },
        loginWithConfirmationCode: async () => ({ token: 'xoxc-code', cookie: 'xoxd-code', workspace: 'Acme' }),
      })

      expect(result).toEqual({ ok: true })
      expect(requestedCode).toBe(false)
      const store = new SecretsSlackCredentialStore({ mode: 'host', secretsPath: join(dir, 'secrets.json') })
      const account = await store.getAccount()
      expect(account?.token).toBe('xoxc-code')
      expect(account?.cookie).toBe('xoxd-code')
      expect(account?.workspace_name).toBe('Acme')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns a failure result when confirmation login throws', async () => {
    const dir = await tmp()
    try {
      const result = await runSlackConfirmationBootstrap({
        agentDir: dir,
        qrDataUrl: 'data:image/png;base64,AAAA',
        email: 'user@acme.com',
        requestCode: async () => '000000',
        loginWithConfirmationCode: async () => {
          throw new Error('session_not_issued')
        },
      })

      expect(result).toEqual({ ok: false, reason: 'session_not_issued' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
