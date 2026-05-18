import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTunnelBridge } from '@/channels/tunnel-bridge'
import { createStream } from '@/stream'
import { waitFor } from '@/test-helpers/wait-for'

import { createTunnelManager } from './manager'

function silentLogger(): { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function installFakeCloudflared(scratchDir: string): string {
  const path = join(scratchDir, 'fake-cloudflared')
  writeFileSync(
    path,
    `#!/bin/sh
echo "2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "2026-01-01T00:00:00Z INF | https://integration.trycloudflare.com |" >&2
`,
    'utf8',
  )
  chmodSync(path, 0o755)
  return path
}

describe('tunnel URL to channel adapter restart integration', () => {
  test('cloudflare quick URL broadcasts restart github and the fresh adapter sees tunnelUrl()', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'typeclaw-tunnels-integration-'))
    const stream = createStream()
    const manager = createTunnelManager({
      stream,
      cloudflareQuickBinary: installFakeCloudflared(scratchDir),
      resolveChannelUpstreamPort: (name) => (name === 'github' ? 8975 : null),
      logger: silentLogger(),
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
        },
      ],
    })
    const startedUrls: Array<string | null> = []
    const bridge = createTunnelBridge({
      stream,
      logger: silentLogger(),
      channelManager: {
        restartAdapter: async (name) => {
          if (name === 'github') startedUrls.push(manager.urlFor('github-webhook'))
        },
      },
    })

    try {
      await manager.start()
      await waitFor(() => startedUrls.length === 1, { description: 'github adapter restart from tunnel URL' })

      expect(startedUrls).toEqual(['https://integration.trycloudflare.com'])
      expect(manager.urlFor('github-webhook')).toBe('https://integration.trycloudflare.com')
    } finally {
      bridge.stop()
      await manager.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
