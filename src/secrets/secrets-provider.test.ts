import { afterEach, describe, expect, test } from 'bun:test'

import type { Request, Response } from '@/hostd/protocol'

import { createHostdSecretsProvider } from './secrets-provider'

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
    const provider = createHostdSecretsProvider({ hostdUrl: hostd.url, restartToken: 'secret', containerName: 'coder' })

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
    const provider = createHostdSecretsProvider({ hostdUrl: hostd.url, restartToken: 'wrong', containerName: 'coder' })

    await expect(provider.writeBackChannelBlock({ discord: { currentAccount: null, accounts: {} } })).rejects.toThrow(
      /secrets-patch failed/,
    )
  })
})

function json(response: Response, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } })
}
