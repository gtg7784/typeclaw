import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Request, Response } from '@/hostd/protocol'

import { createFileSecretsProvider, createHostdSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function startFakeHostd(token: string, containerName: string): { url: string; requests: Request[] } {
  const requests: Request[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        return json({ ok: false, reason: 'invalid restart token' }, 403)
      }
      const rpc = (await req.json()) as Request
      requests.push(rpc)
      return json({ ok: true, result: { containerName, patched: true } })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

describe('createHostdSecretsProvider', () => {
  test('forwards the block as a secrets-patch RPC with Bearer auth', async () => {
    const hostd = startFakeHostd('secret', 'coder')
    const provider = createHostdSecretsProvider({
      hostdUrl: hostd.url,
      restartToken: 'secret',
      containerName: 'coder',
      secretsPath: '/nonexistent/secrets.json',
    })

    await provider.writeBackChannelBlock({ discord: { currentAccount: null, accounts: {} } })

    expect(hostd.requests).toHaveLength(1)
    const rpc = hostd.requests[0]
    expect(rpc?.kind).toBe('secrets-patch')
    if (rpc?.kind !== 'secrets-patch') throw new Error('expected secrets-patch')
    expect(rpc.containerName).toBe('coder')
    expect(rpc.patch.channels).toEqual({ discord: { currentAccount: null, accounts: {} } })
  })

  test('throws when hostd rejects the patch', async () => {
    const hostd = startFakeHostd('secret', 'coder')
    const provider = createHostdSecretsProvider({
      hostdUrl: hostd.url,
      restartToken: 'wrong',
      containerName: 'coder',
      secretsPath: '/nonexistent/secrets.json',
    })

    await expect(provider.writeBackChannelBlock({ discord: { currentAccount: null, accounts: {} } })).rejects.toThrow(
      /secrets-patch failed/,
    )
  })

  test('reads channels from the mounted secrets.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-provider-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      const backend = new SecretsBackend(secretsPath)
      await backend.updateChannelsAsync(async () => ({
        result: undefined,
        next: { discord: { currentAccount: 'd1', accounts: {} } },
      }))
      const provider = createHostdSecretsProvider({
        hostdUrl: 'http://127.0.0.1:1',
        restartToken: 'secret',
        containerName: 'coder',
        secretsPath,
      })

      expect(provider.readChannels()?.discord).toEqual({ currentAccount: 'd1', accounts: {} })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads null when the mounted secrets.json is absent', () => {
    const provider = createHostdSecretsProvider({
      hostdUrl: 'http://127.0.0.1:1',
      restartToken: 'secret',
      containerName: 'coder',
      secretsPath: '/nonexistent/secrets.json',
    })
    expect(provider.readChannels()).toBeNull()
  })
})

describe('createFileSecretsProvider', () => {
  test('round-trips a channel block through the file (read after write)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-file-provider-'))
    try {
      const secretsPath = join(root, 'secrets.json')
      new SecretsBackend(secretsPath).writeChannelsSync({})
      const provider = createFileSecretsProvider(secretsPath)

      await provider.writeBackChannelBlock({ discord: { currentAccount: 'd1', accounts: {} } })

      expect(provider.readChannels()?.discord).toEqual({ currentAccount: 'd1', accounts: {} })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads null when the file is absent', () => {
    const provider = createFileSecretsProvider('/nonexistent/secrets.json')
    expect(provider.readChannels()).toBeNull()
  })
})

function json(response: Response, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } })
}
