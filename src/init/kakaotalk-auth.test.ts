import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  kakaotalkConfigDir,
  kakaotalkSecretsPath,
  type LoginFlowFn,
  type LoginFlowOptions,
  type LoginFlowResult,
  runKakaotalkBootstrap,
} from './kakaotalk-auth'

describe('kakaotalkConfigDir', () => {
  test('places credentials under the agent workspace, not the user home', () => {
    const dir = kakaotalkConfigDir('/foo/agent')
    expect(dir).toBe('/foo/agent/workspace/.agent-messenger')
  })
})

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-kakao-test-'))

const successResult: LoginFlowResult = {
  authenticated: true,
  credentials: {
    access_token: 'oauth-abc',
    refresh_token: 'refresh-xyz',
    user_id: 'user-1',
    device_uuid: 'uuid-1',
    device_type: 'tablet',
  },
}

describe('runKakaotalkBootstrap', () => {
  test('persists credentials when loginFlow returns authenticated', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async (opts) => {
        expect(opts.email).toBe('user@example.com')
        expect(opts.password).toBe('secret')
        expect(opts.deviceType).toBe('tablet')
        return successResult
      }
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'secret',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
      })
      expect(result).toEqual({ ok: true })
      const stored = JSON.parse(await readFile(kakaotalkSecretsPath(agentDir), 'utf8')) as {
        channels: {
          kakaotalk: {
            currentAccount: string
            accounts: Record<string, { user_id: string; auth_method: string; oauth_token: string }>
          }
        }
      }
      expect(stored.channels.kakaotalk.currentAccount).toBe('user-1')
      expect(stored.channels.kakaotalk.accounts['user-1']?.oauth_token).toBe('oauth-abc')
      expect(stored.channels.kakaotalk.accounts['user-1']?.auth_method).toBe('login')
      await expect(readFile(join(kakaotalkConfigDir(agentDir), 'kakaotalk-credentials.json'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure with the loginFlow message when authentication fails', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => ({
        authenticated: false,
        error: 'bad_credentials',
        message: 'Login failed: incorrect email or password.',
      })
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'wrong',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('Login failed: incorrect email or password.')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when loginFlow throws', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => {
        throw new Error('network unreachable')
      }
      const result = await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('network unreachable')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('forwards onPasscode through to loginFlow as onPasscodeDisplay', async () => {
    const agentDir = await tmp()
    try {
      const codes: string[] = []
      const fake: LoginFlowFn = async (opts: LoginFlowOptions) => {
        opts.onPasscodeDisplay?.('1234')
        return successResult
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: (code) => codes.push(code) },
        loginFlow: fake,
      })
      expect(codes).toEqual(['1234'])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('reuses savedDeviceUuid from prior pending login', async () => {
    const agentDir = await tmp()
    try {
      await mkdir(agentDir, { recursive: true })
      await writeFile(
        kakaotalkSecretsPath(agentDir),
        JSON.stringify({
          version: 2,
          providers: {},
          channels: {
            kakaotalk: {
              currentAccount: null,
              accounts: {},
              pendingLogin: {
                device_uuid: 'previous-uuid',
                device_type: 'tablet',
                email: 'u@e.com',
                created_at: new Date().toISOString(),
              },
            },
          },
        }),
      )
      let received: string | undefined
      const fake: LoginFlowFn = async (opts) => {
        received = opts.savedDeviceUuid
        return successResult
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
      })
      expect(received).toBe('previous-uuid')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('uses default account_id when user_id is empty', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => ({
        authenticated: true,
        credentials: {
          access_token: 'oauth',
          refresh_token: 'refresh',
          user_id: '',
          device_uuid: 'uuid',
          device_type: 'tablet',
        },
      })
      const result = await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
      })
      expect(result).toEqual({ ok: true })
      const stored = JSON.parse(await readFile(kakaotalkSecretsPath(agentDir), 'utf8')) as {
        channels: { kakaotalk: { currentAccount: string } }
      }
      expect(stored.channels.kakaotalk.currentAccount).toBe('default')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
