import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LineAccountCredentials } from 'agent-messenger/line'

import type { Request } from '@/hostd/protocol'

import { SecretsLineCredentialStore } from './line-store'
import { createHostdSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

async function withStore<T>(fn: (store: SecretsLineCredentialStore, secretsPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-line-store-'))
  try {
    const secretsPath = join(root, 'secrets.json')
    return await fn(new SecretsLineCredentialStore({ mode: 'host', secretsPath }), secretsPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function account(id: string, overrides: Partial<LineAccountCredentials> = {}): LineAccountCredentials {
  return {
    account_id: id,
    auth_token: `token-${id}`,
    certificate: `cert-${id}`,
    device: 'DESKTOPMAC',
    display_name: `Name ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SecretsLineCredentialStore host mode', () => {
  test('round-trips setAccount through secrets.json#channels.line', async () => {
    await withStore(async (store, secretsPath) => {
      await store.setAccount(account('mid-1'))

      expect(await store.getAccount()).toEqual(account('mid-1'))
      const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as { channels: Record<string, unknown> }
      expect(raw.channels.line).toEqual({ currentAccount: 'mid-1', accounts: { 'mid-1': account('mid-1') } })
    })
  })

  test('supports multiple accounts and current-account switching', async () => {
    await withStore(async (store) => {
      await store.setAccount(account('mid-1'))
      await store.setAccount(account('mid-2'))
      await store.setCurrentAccount('mid-2')

      expect(await store.getAccount()).toEqual(account('mid-2'))
      expect(await store.getAccount('mid-1')).toEqual(account('mid-1'))
      expect(await store.listAccounts()).toEqual([
        { ...account('mid-1'), is_current: false },
        { ...account('mid-2'), is_current: true },
      ])
    })
  })

  test('removeAccount deletes the account and picks a replacement current account', async () => {
    await withStore(async (store) => {
      await store.setAccount(account('mid-1'))
      await store.setAccount(account('mid-2'))
      await store.removeAccount('mid-1')

      expect(await store.getAccount('mid-1')).toBeNull()
      expect((await store.load()).current_account).toBe('mid-2')
    })
  })

  test('reads an absent secrets.json as an empty config', async () => {
    await withStore(async (store) => {
      expect(await store.load()).toEqual({ current_account: null, accounts: {} })
      expect(await store.getAccount()).toBeNull()
    })
  })
})

describe('SecretsLineCredentialStore container mode', () => {
  const servers: Array<{ stop: () => void }> = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop()
  })

  test('forwards setAccount to hostd as a line secrets-patch and the host applies it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-line-store-container-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      const token = 'restart-token'
      const containerName = 'agent-1'
      const patches: Request[] = []

      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          if (req.headers.get('authorization') !== `Bearer ${token}`) {
            return Response.json({ ok: false, reason: 'invalid token' }, { status: 403 })
          }
          const rpc = (await req.json()) as Request
          patches.push(rpc)
          if (rpc.kind !== 'secrets-patch') return Response.json({ ok: false, reason: 'unsupported' }, { status: 403 })
          if (!('line' in rpc.patch.channels)) {
            return Response.json({ ok: false, reason: 'expected line patch' }, { status: 403 })
          }
          const lineBlock = rpc.patch.channels.line
          await new SecretsBackend(secretsPath).updateChannelsAsync(async (channels) => ({
            result: undefined,
            next: { ...channels, line: lineBlock },
          }))
          return Response.json({ ok: true, result: { containerName, patched: true } })
        },
      })
      servers.push(server)

      const store = new SecretsLineCredentialStore({
        mode: 'container',
        secretsPath,
        hostProvider: createHostdSecretsProvider({
          hostdUrl: `http://127.0.0.1:${server.port}`,
          restartToken: token,
          containerName,
          secretsPath,
        }),
      })
      await store.setAccount(account('mid-1'))

      expect(patches).toHaveLength(1)
      const onDisk = JSON.parse(await readFile(secretsPath, 'utf8')) as { channels: Record<string, unknown> }
      expect(onDisk.channels.line).toEqual({ currentAccount: 'mid-1', accounts: { 'mid-1': account('mid-1') } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
