import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { waitFor } from '@/test-helpers/wait-for'

import { createCloudflareNamedProvider } from './cloudflare-named'

const config = {
  name: 'github-webhook',
  provider: 'cloudflare-named',
  for: { kind: 'channel', name: 'github' },
  hostname: 'https://agent.example.com',
  tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
} as const

describe('createCloudflareNamedProvider', () => {
  function createScratchDir(): string {
    return mkdtempSync(join(tmpdir(), 'cloudflare-named-test-'))
  }

  function installFakeCloudflared(scratchDir: string, script: string): string {
    const path = join(scratchDir, 'fake-cloudflared')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    return path
  }

  it('emits the configured hostname synchronously at start and spawns cloudflared with the token', async () => {
    const scratchDir = createScratchDir()
    const argvFile = join(scratchDir, 'argv.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
printf '%s\n' "$@" > "${argvFile}"
echo "2026-01-01T00:00:00Z INF Connection registered" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const urls: string[] = []
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: (url) => urls.push(url),
      resolveToken: () => 'eyJhIjoiZmFrZS10b2tlbiJ9',
      stopGraceMs: 10,
    })

    try {
      // URL must be emitted synchronously - subscribers wire up immediately,
      // not after cloudflared comes up.
      await provider.start()
      expect(urls).toEqual(['https://agent.example.com'])
      expect(provider.snapshot().url).toBe('https://agent.example.com')

      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy after first stderr' })
      expect((await readFile(argvFile, 'utf8')).split('\n').filter(Boolean)).toEqual([
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token',
        'eyJhIjoiZmFrZS10b2tlbiJ9',
      ])

      await provider.stop()
      expect(provider.snapshot().status).toBe('stopped')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('flips to permanently-failed when the token env var is unset', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(scratchDir, 'exit 0')
    const urls: string[] = []
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: (url) => urls.push(url),
      resolveToken: () => undefined,
      stopGraceMs: 10,
    })

    try {
      await provider.start()

      // URL still emits (hostname is config-bound, not process-bound) so
      // subscribers like channel adapters see the right URL, but the tunnel
      // is permanently-failed because no token exists to spawn cloudflared.
      expect(urls).toEqual(['https://agent.example.com'])
      const snap = provider.snapshot()
      expect(snap.status).toBe('permanently-failed')
      expect(snap.detail).toContain('CLOUDFLARE_TUNNEL_TOKEN')
      expect(snap.url).toBe('https://agent.example.com')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('also flips to permanently-failed when the token env var is empty string', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(scratchDir, 'exit 0')
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: () => {},
      resolveToken: () => '',
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      expect(provider.snapshot().status).toBe('permanently-failed')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('restarts a crashed process with backoff', async () => {
    const scratchDir = createScratchDir()
    const countFile = join(scratchDir, 'count.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
count=0
if [ -f "${countFile}" ]; then count=$(cat "${countFile}"); fi
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
if [ "$count" -eq 1 ]; then
  echo first crash >&2
  exit 2
fi
echo "INF Connection registered after restart" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: () => {},
      resolveToken: () => 'fake-token',
      restartBackoffMs: [5],
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      // Neither signal is reliable alone: launch 1's stderr ("first crash")
      // flips health momentarily before it exits (count still 1), and launch 2
      // writes the count file before emitting its own stderr (count 2 while
      // status is still 'starting'). The post-restart steady state is the
      // conjunction, so poll for both rather than asserting one after the other.
      await waitFor(
        async () => {
          if (provider.snapshot().status !== 'healthy') return false
          try {
            return (await readFile(countFile, 'utf8')) === '2'
          } catch {
            return false
          }
        },
        { description: 'healthy after second launch' },
      )
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('stops retrying after the consecutive-crash cap is reached', async () => {
    const scratchDir = createScratchDir()
    const countFile = join(scratchDir, 'count.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
count=0
if [ -f "${countFile}" ]; then count=$(cat "${countFile}"); fi
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
echo crash "$count" >&2
exit 3
`,
    )
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: () => {},
      resolveToken: () => 'fake-token',
      restartBackoffMs: [1],
      maxConsecutiveCrashes: 2,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'permanently-failed', { description: 'permanent failure' })

      expect(await readFile(countFile, 'utf8')).toBe('2')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('SIGKILLs processes that ignore SIGTERM during stop', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "INF Connection registered" >&2
trap '' TERM
sleep 30
`,
    )
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: () => {},
      resolveToken: () => 'fake-token',
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy' })

      await provider.stop()
      expect(provider.snapshot().status).toBe('stopped')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('rejects construction when hostname is missing', () => {
    expect(() =>
      createCloudflareNamedProvider({
        config: { ...config, hostname: undefined } as unknown as typeof config,
        onUrlChange: () => {},
        resolveToken: () => 'fake-token',
      }),
    ).toThrow(/hostname is required/)
  })

  it('rejects construction when tokenEnv is missing', () => {
    expect(() =>
      createCloudflareNamedProvider({
        config: { ...config, tokenEnv: undefined } as unknown as typeof config,
        onUrlChange: () => {},
        resolveToken: () => 'fake-token',
      }),
    ).toThrow(/tokenEnv is required/)
  })

  it('rejects construction when the provider field disagrees', () => {
    expect(() =>
      createCloudflareNamedProvider({
        config: { ...config, provider: 'cloudflare-quick' } as unknown as typeof config,
        onUrlChange: () => {},
        resolveToken: () => 'fake-token',
      }),
    ).toThrow(/provider must be 'cloudflare-named'/)
  })

  it('subscribers receive future stderr lines without replay', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo before >&2
sleep 0.05
echo after >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const provider = createCloudflareNamedProvider({
      config,
      binary,
      onUrlChange: () => {},
      resolveToken: () => 'fake-token',
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.tail().includes('before'), { description: 'first log line' })
      const received: string[] = []
      provider.subscribeToLogs((line) => received.push(line))
      await waitFor(() => received.includes('after'), { description: 'future log line' })

      expect(received).toEqual(['after'])
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
