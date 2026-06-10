import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LineLoginResult } from 'agent-messenger/line'

import { SecretsLineCredentialStore } from '@/secrets/line-store'

import { runLineBootstrap, type LineLoginClient } from './line-auth'

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-line-auth-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// The real SDK persists via the credential manager wired into the client. The
// production code passes our SecretsLineCredentialStore as that manager, so the
// fake mirrors that by writing through a store the test also constructs.
function fakeClient(agentDir: string, result: LineLoginResult): LineLoginClient {
  const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: join(agentDir, 'secrets.json') })
  const persist = async (): Promise<LineLoginResult> => {
    if (result.authenticated && result.account_id !== undefined) {
      await store.setAccount({
        account_id: result.account_id,
        auth_token: 'persisted-token',
        device: 'DESKTOPMAC',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
    }
    return result
  }
  return {
    loginWithQR: persist,
    loginWithEmail: persist,
  }
}

// Models an SDK that authenticates but never calls setAccount() — nothing
// lands in secrets.json. runLineBootstrap must treat this as a failure rather
// than a green "added".
function nonPersistingClient(result: LineLoginResult): LineLoginClient {
  const login = async (): Promise<LineLoginResult> => result
  return { loginWithQR: login, loginWithEmail: login }
}

function loggingClient(agentDir: string): LineLoginClient {
  const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: join(agentDir, 'secrets.json') })
  const login = async (): Promise<LineLoginResult> => {
    console.log(lineTokenInfoDump())
    console.log('visible login progress')
    await store.setAccount({
      account_id: 'mid-logged',
      auth_token: 'persisted-token',
      device: 'DESKTOPMAC',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    return { authenticated: true, account_id: 'mid-logged' }
  }
  return { loginWithQR: login, loginWithEmail: login }
}

function lineTokenInfoDump(): Record<string, unknown> {
  return {
    1: 'header.payload.signature',
    2: 'refresh.header.payload',
    3: 3600,
    4: { 1: 200 },
    5: 'session-id',
    6: 1781093119,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function controlledLoggingClient(
  agentDir: string,
  accountId: string,
  entered: string[],
  release: Promise<void>,
): LineLoginClient {
  const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: join(agentDir, 'secrets.json') })
  const login = async (): Promise<LineLoginResult> => {
    entered.push(accountId)
    console.log(lineTokenInfoDump())
    await release
    await store.setAccount({
      account_id: accountId,
      auth_token: 'persisted-token',
      device: 'DESKTOPMAC',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    return { authenticated: true, account_id: accountId }
  }
  return { loginWithQR: login, loginWithEmail: login }
}

function throwingLoggingClient(): LineLoginClient {
  const login = async (): Promise<LineLoginResult> => {
    console.log(lineTokenInfoDump())
    throw new Error('login exploded')
  }
  return { loginWithQR: login, loginWithEmail: login }
}

describe('runLineBootstrap', () => {
  test('persists the account and sets it current on a successful QR login', async () => {
    await withDir(async (dir) => {
      const status = await runLineBootstrap({
        method: 'qr',
        agentDir: dir,
        callbacks: { onPincode: () => {}, onQRUrl: () => {} },
        client: fakeClient(dir, { authenticated: true, account_id: 'mid-1', display_name: 'Alice' }),
      })
      expect(status).toEqual({ ok: true })

      const raw = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')) as {
        channels: { line: { currentAccount: string } }
      }
      expect(raw.channels.line.currentAccount).toBe('mid-1')
    })
  })

  test('persists the account on a successful email login', async () => {
    await withDir(async (dir) => {
      const status = await runLineBootstrap({
        method: 'email',
        email: 'a@example.com',
        password: 'secret',
        agentDir: dir,
        callbacks: { onPincode: () => {} },
        client: fakeClient(dir, { authenticated: true, account_id: 'mid-2' }),
      })
      expect(status).toEqual({ ok: true })
    })
  })

  test('reports a failure reason when login does not authenticate', async () => {
    await withDir(async (dir) => {
      const status = await runLineBootstrap({
        method: 'qr',
        agentDir: dir,
        callbacks: { onPincode: () => {} },
        client: fakeClient(dir, { authenticated: false, error: 'pin rejected' }),
      })
      expect(status).toEqual({ ok: false, reason: 'pin rejected' })
    })
  })

  test('fails when login authenticates but no credentials were persisted', async () => {
    await withDir(async (dir) => {
      const status = await runLineBootstrap({
        method: 'qr',
        agentDir: dir,
        callbacks: { onPincode: () => {}, onQRUrl: () => {} },
        client: nonPersistingClient({ authenticated: true, account_id: 'mid-1' }),
      })
      expect(status).toEqual({ ok: false, reason: 'LINE login authenticated but did not persist credentials' })
    })
  })

  test('suppresses the upstream LINE token info dump without muting other logs', async () => {
    await withDir(async (dir) => {
      const originalLog = console.log
      const logged: unknown[][] = []
      const captureLog = (...args: unknown[]) => {
        logged.push(args)
      }
      console.log = captureLog
      try {
        const status = await runLineBootstrap({
          method: 'qr',
          agentDir: dir,
          callbacks: { onPincode: () => {}, onQRUrl: () => {} },
          client: loggingClient(dir),
        })

        expect(status).toEqual({ ok: true })
        expect(console.log).toBe(captureLog)
      } finally {
        console.log = originalLog
      }

      expect(logged).toEqual([['visible login progress']])
    })
  })

  test('serializes overlapping token dump suppression and restores console.log', async () => {
    await withDir(async (firstDir) => {
      await withDir(async (secondDir) => {
        const originalLog = console.log
        const logged: unknown[][] = []
        const entered: string[] = []
        const firstRelease = deferred()
        const secondRelease = deferred()
        const captureLog = (...args: unknown[]) => {
          logged.push(args)
        }
        console.log = captureLog
        try {
          const first = runLineBootstrap({
            method: 'qr',
            agentDir: firstDir,
            callbacks: { onPincode: () => {}, onQRUrl: () => {} },
            client: controlledLoggingClient(firstDir, 'mid-first', entered, firstRelease.promise),
          })
          const second = runLineBootstrap({
            method: 'qr',
            agentDir: secondDir,
            callbacks: { onPincode: () => {}, onQRUrl: () => {} },
            client: controlledLoggingClient(secondDir, 'mid-second', entered, secondRelease.promise),
          })

          await Promise.resolve()
          expect(entered).toEqual(['mid-first'])

          firstRelease.resolve()
          await expect(first).resolves.toEqual({ ok: true })
          await Promise.resolve()
          expect(entered).toEqual(['mid-first', 'mid-second'])

          secondRelease.resolve()
          await expect(second).resolves.toEqual({ ok: true })
          expect(console.log).toBe(captureLog)
        } finally {
          console.log = originalLog
        }

        expect(logged).toEqual([])
      })
    })
  })

  test('restores console.log when LINE login throws', async () => {
    await withDir(async (dir) => {
      const originalLog = console.log
      const logged: unknown[][] = []
      const captureLog = (...args: unknown[]) => {
        logged.push(args)
      }
      console.log = captureLog
      try {
        const status = await runLineBootstrap({
          method: 'qr',
          agentDir: dir,
          callbacks: { onPincode: () => {}, onQRUrl: () => {} },
          client: throwingLoggingClient(),
        })

        expect(status).toEqual({ ok: false, reason: 'login exploded' })
        expect(console.log).toBe(captureLog)
      } finally {
        console.log = originalLog
      }

      expect(logged).toEqual([])
    })
  })
})
