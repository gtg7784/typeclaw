import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LineLoginResult } from 'agent-messenger/line'

import { SecretsLineCredentialStore } from '@/secrets/line-store'

import { lineConfigDir, runLineBootstrap, type LineLoginClient } from './line-auth'

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

// Like fakeClient, but invokes `onLogin` synchronously inside the login call so
// a test can observe process state (e.g. AGENT_MESSENGER_CONFIG_DIR) while the
// SDK would be constructing its storage.
function observingClient(agentDir: string, result: LineLoginResult, onLogin: () => void): LineLoginClient {
  const store = new SecretsLineCredentialStore({ mode: 'host', secretsPath: join(agentDir, 'secrets.json') })
  const persist = async (): Promise<LineLoginResult> => {
    onLogin()
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
  return { loginWithQR: persist, loginWithEmail: persist }
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
  test('points the SDK E2EE storage at the agent workspace during login, then restores the env', async () => {
    await withDir(async (dir) => {
      const saved = process.env.AGENT_MESSENGER_CONFIG_DIR
      delete process.env.AGENT_MESSENGER_CONFIG_DIR
      try {
        let duringLogin: string | undefined
        await runLineBootstrap({
          method: 'qr',
          agentDir: dir,
          callbacks: { onPincode: () => {}, onQRUrl: () => {} },
          client: observingClient(dir, { authenticated: true, account_id: 'mid-cfg' }, () => {
            duringLogin = process.env.AGENT_MESSENGER_CONFIG_DIR
          }),
        })
        // set for the SDK during login...
        expect(duringLogin ?? '').toBe(lineConfigDir(dir))
        // ...and restored afterward so it cannot leak into a later bootstrap
        expect(process.env.AGENT_MESSENGER_CONFIG_DIR).toBeUndefined()
      } finally {
        if (saved === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
        else process.env.AGENT_MESSENGER_CONFIG_DIR = saved
      }
    })
  })

  test('does not let a second bootstrap inherit the first agent dir', async () => {
    await withDir(async (dirA) => {
      await withDir(async (dirB) => {
        const saved = process.env.AGENT_MESSENGER_CONFIG_DIR
        delete process.env.AGENT_MESSENGER_CONFIG_DIR
        try {
          await runLineBootstrap({
            method: 'qr',
            agentDir: dirA,
            callbacks: { onPincode: () => {}, onQRUrl: () => {} },
            client: fakeClient(dirA, { authenticated: true, account_id: 'mid-a' }),
          })

          let duringSecond: string | undefined
          await runLineBootstrap({
            method: 'qr',
            agentDir: dirB,
            callbacks: { onPincode: () => {}, onQRUrl: () => {} },
            client: observingClient(dirB, { authenticated: true, account_id: 'mid-b' }, () => {
              duringSecond = process.env.AGENT_MESSENGER_CONFIG_DIR
            }),
          })
          // the second bootstrap uses its OWN agent dir, not the first's
          expect(duringSecond ?? '').toBe(lineConfigDir(dirB))
        } finally {
          if (saved === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
          else process.env.AGENT_MESSENGER_CONFIG_DIR = saved
        }
      })
    })
  })

  test('does not override an already-set config dir (container stage owns it)', async () => {
    await withDir(async (dir) => {
      const saved = process.env.AGENT_MESSENGER_CONFIG_DIR
      process.env.AGENT_MESSENGER_CONFIG_DIR = '/agent/workspace/.agent-messenger'
      try {
        let duringLogin: string | undefined
        await runLineBootstrap({
          method: 'qr',
          agentDir: dir,
          callbacks: { onPincode: () => {}, onQRUrl: () => {} },
          client: observingClient(dir, { authenticated: true, account_id: 'mid-cfg2' }, () => {
            duringLogin = process.env.AGENT_MESSENGER_CONFIG_DIR
          }),
        })
        expect(duringLogin ?? '').toBe('/agent/workspace/.agent-messenger')
        expect(process.env.AGENT_MESSENGER_CONFIG_DIR ?? '').toBe('/agent/workspace/.agent-messenger')
      } finally {
        if (saved === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
        else process.env.AGENT_MESSENGER_CONFIG_DIR = saved
      }
    })
  })

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
