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

  test('interactive add writes a cloudflare-named channel tunnel and enables cloudflared', async () => {
    const cwd = await makeAgentDir({})
    const prompts = sequencedPrompts(['https://agent.example.com', 'CLOUDFLARE_TUNNEL_TOKEN'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'github-webhook', forChannel: 'github' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        text: prompts.text,
      },
    )

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'github-webhook',
        provider: 'cloudflare-named',
        for: { kind: 'channel', name: 'github' },
        hostname: 'https://agent.example.com',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ])
    expect(config.docker.file.cloudflared).toBe(true)
  })

  test('non-interactive add writes a cloudflare-named manual tunnel without upstreamPort', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'public-demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'https://demo.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'public-demo',
        provider: 'cloudflare-named',
        for: { kind: 'manual' },
        hostname: 'https://demo.example.com',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ])
    expect(config.tunnels[0].upstreamPort).toBeUndefined()
  })

  test('add rejects cloudflare-named with non-https hostname', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'http://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/https:\/\//)
  })

  test('add rejects cloudflare-named with lowercase tokenEnv', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'https://agent.example.com',
      tokenEnv: 'my_token',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/env var name/)
  })

  test('interactive add prompts for the name when omitted and writes the new tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'existing',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })
    const prompts = sequencedPrompts(['fresh', '5174'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: prompts.text,
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('fresh')
    const config = await readConfig(cwd)
    expect(config.tunnels.map((entry: { name: string }) => entry.name)).toEqual(['existing', 'fresh'])
  })

  test('add rejects a duplicate name surfaced through the interactive prompt', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'existing',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })
    const prompts = sequencedPrompts(['existing'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: prompts.text,
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/already exists/)
  })

  test('non-interactive add rejects a name that violates the schema regex', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'Bad Name',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/lowercase, digits/)
    const config = await readConfig(cwd)
    expect(config.tunnels ?? []).toEqual([])
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

  test('add refuses cleanly with a result-shaped reason when typeclaw.json is malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), 'NOT JSON AT ALL {{{', 'utf8')

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not valid JSON/)
  })

  test('add refuses cleanly with a result-shaped reason when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
  })

  test('remove refuses cleanly with a result-shaped reason when typeclaw.json is malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json', 'utf8')

    const result = tunnel.runTunnelRemoveFlow(cwd, { name: 'demo' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not valid JSON/)
  })

  test('remove refuses cleanly with a result-shaped reason when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = tunnel.runTunnelRemoveFlow(cwd, { name: 'demo' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
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
    expect(refused.reason).toContain('typeclaw tunnel set github-webhook')
    expect(removed.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels.map((entry: { name: string }) => entry.name)).toEqual(['github-webhook'])
  })
})

describe('tunnel set config flow', () => {
  test('non-interactive set rewrites externalUrl on a channel-owned tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.externalUrl).toBe('https://new.example.com')
    expect(result.value.for).toEqual({ kind: 'channel', name: 'github' })
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://new.example.com')
  })

  test('non-interactive set swaps provider from cloudflare-quick to cloudflare-named and enables cloudflared', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
          upstreamPort: 8975,
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      provider: 'cloudflare-named',
      hostname: 'https://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.provider).toBe('cloudflare-named')
    expect(result.value.hostname).toBe('https://agent.example.com')
    expect(result.value.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    expect(result.value.upstreamPort).toBeUndefined()
    const config = await readConfig(cwd)
    expect(config.tunnels[0].upstreamPort).toBeUndefined()
    expect(config.docker?.file?.cloudflared).toBe(true)
  })

  test('non-interactive set rejects unknown tunnel name', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'does-not-exist',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/unknown tunnel/)
  })

  test('non-interactive set rejects http externalUrl with a clean reason', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'http://insecure.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/https:\/\//)
    // typeclaw.json must be untouched on failure (the strict-gate semantics
    // documented in runTunnelAddFlow).
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://hook.example.com')
  })

  test('non-interactive set provider=external without --external-url fails (no interactive prompt)', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      provider: 'external',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/--external-url/)
    const config = await readConfig(cwd)
    expect(config.tunnels[0].provider).toBe('cloudflare-quick')
  })

  test('interactive set picks externalUrl field and rewrites it', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'manual-demo' },
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => 'https://new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.externalUrl).toBe('https://new.example.com')
  })

  test('interactive set with no name auto-picks the only configured tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => 'https://new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('manual-demo')
    expect(result.value.externalUrl).toBe('https://new.example.com')
  })

  test('interactive set with no name picks from multiple configured tunnels', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'first',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://first.example.com',
        },
        {
          name: 'second',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5174,
          externalUrl: 'https://second-old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        selectExistingTunnel: async () => 'second',
        text: async () => 'https://second-new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('second')
    expect(result.value.externalUrl).toBe('https://second-new.example.com')
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://first.example.com')
    expect(config.tunnels[1].externalUrl).toBe('https://second-new.example.com')
  })

  test('set refuses cleanly with no name when there are zero tunnels', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelSetFlow(cwd, {})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/no tunnels configured/)
  })

  test('set refuses cleanly when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
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

function sequencedPrompts(answers: string[]): { text: (message: string) => Promise<string> } {
  let idx = 0
  return {
    text: async () => {
      if (idx >= answers.length) throw new Error(`sequencedPrompts: no answer at index ${idx}`)
      return answers[idx++]!
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
