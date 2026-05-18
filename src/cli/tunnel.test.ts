import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { createServer } from '@/server'
import type { TunnelManager, TunnelState } from '@/tunnels'

const tunnel = await import('./tunnel')

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null
let prevNoColor: string | undefined

beforeEach(() => {
  prevNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
})

afterEach(() => {
  server?.stop(true)
  server = null
  if (prevNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = prevNoColor
})

describe('tunnel add/remove config flows', () => {
  test('interactive add writes a cloudflare-quick manual tunnel and enables cloudflared', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'demo' },
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: async () => '5173',
      },
    )

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      { name: 'demo', provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: 5173 },
    ])
    expect(config.docker.file.cloudflared).toBe(true)
  })

  test('non-interactive add writes an external manual tunnel', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'manual-demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'manual-demo',
        provider: 'external',
        for: { kind: 'manual' },
        upstreamPort: 5173,
        externalUrl: 'https://demo.example.com',
      },
    ])
  })

  test('remove refuses channel-owned tunnels and removes manual tunnels', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })

    const refused = tunnel.runTunnelRemoveFlow(cwd, { name: 'github-webhook' })
    const removed = tunnel.runTunnelRemoveFlow(cwd, { name: 'manual-demo' })

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.reason).toContain('typeclaw channel remove github')
    expect(removed.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels.map((entry: { name: string }) => entry.name)).toEqual(['github-webhook'])
  })
})

describe('tunnel live commands', () => {
  test('list against a websocket server prints expected rows', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => fakeSession(),
      tunnelManager: makeTunnelManager(),
    }).start()
    server = built

    const result = await tunnel.fetchTunnelList({ cwd: process.cwd(), url: `ws://localhost:${built.port}` })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const out = tunnel.formatTunnelList(result.value)
    expect(out).toContain('github-webhook')
    expect(out).toContain('cloudflare-quick')
    expect(out).toContain('https://example.trycloudflare.com')
  })

  test('logs without follow receives snapshot and exits', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => fakeSession(),
      tunnelManager: makeTunnelManager(),
    }).start()
    server = built

    const result = await tunnel.fetchTunnelLogs({
      cwd: process.cwd(),
      url: `ws://localhost:${built.port}`,
      name: 'github-webhook',
    })

    expect(result).toEqual({ ok: true, value: ['first', 'second'] })
  })

  test('logs -f streams live lines and SIGINT closes cleanly', async () => {
    const manager = makeTunnelManager()
    const built = createServer({ port: 0, createSession: async () => fakeSession(), tunnelManager: manager }).start()
    server = built
    const lines: string[] = []

    const pending = tunnel.streamTunnelLogs(
      { cwd: process.cwd(), url: `ws://localhost:${built.port}`, name: 'github-webhook', follow: true },
      (line) => lines.push(line),
    )
    await waitFor(() => lines.length === 2)
    manager.appendLog('github-webhook', 'live')
    await waitFor(() => lines.includes('live'))
    process.emit('SIGINT')

    await expect(pending).resolves.toEqual({ ok: true, value: undefined })
  })
})

async function makeAgentDir(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-cli-'))
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return dir
}

async function readConfig(cwd: string): Promise<any> {
  return JSON.parse(await Bun.file(join(cwd, 'typeclaw.json')).text())
}

function fakeSession(): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession
}

function makeTunnelManager(): TunnelManager & { appendLog: (name: string, line: string) => void } {
  const state: TunnelState = {
    name: 'github-webhook',
    provider: 'cloudflare-quick',
    for: { kind: 'channel', name: 'github' },
    url: 'https://example.trycloudflare.com',
    status: 'healthy',
    lastUrlAt: 123,
    detail: 'connected',
  }
  const logs = ['first', 'second']
  const subscribers = new Set<(line: string) => void>()
  return {
    start: async () => {},
    stop: async () => {},
    snapshot: () => [state],
    urlFor: () => state.url,
    tail: () => logs,
    subscribeToLogs: (_name, cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    appendLog: (_name, line) => {
      logs.push(line)
      for (const cb of subscribers) cb(line)
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timeout')
}
