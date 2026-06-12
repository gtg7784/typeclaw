import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { waitFor } from '@/test-helpers/wait-for'

import { createCloudflareQuickProvider } from './cloudflare-quick'

const config = {
  name: 'github-webhook',
  provider: 'cloudflare-quick',
  for: { kind: 'channel', name: 'github' },
} as const

describe('createCloudflareQuickProvider', () => {
  function createScratchDir(): string {
    return mkdtempSync(join(tmpdir(), 'cloudflare-quick-test-'))
  }

  function installFakeCloudflared(scratchDir: string, script: string): string {
    const path = join(scratchDir, 'fake-cloudflared')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    return path
  }

  it('spawns cloudflared, captures stderr, and emits the quick tunnel URL', async () => {
    const scratchDir = createScratchDir()
    const argvFile = join(scratchDir, 'argv.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
printf '%s\n' "$@" > "${argvFile}"
echo "2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "2026-01-01T00:00:00Z INF | https://fake.trycloudflare.com |" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const urls: string[] = []
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: (url) => urls.push(url),
      probeUpstream: async () => true,
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => urls.length === 1, { description: 'quick tunnel URL' })

      expect(urls).toEqual(['https://fake.trycloudflare.com'])
      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy after probe' })
      expect(provider.snapshot()).toMatchObject({ status: 'healthy', url: 'https://fake.trycloudflare.com' })
      expect(provider.tail()).toContain('2026-01-01T00:00:00Z INF | https://fake.trycloudflare.com |')
      expect((await readFile(argvFile, 'utf8')).split('\n').filter(Boolean)).toEqual([
        'tunnel',
        '--url',
        'http://127.0.0.1:8975',
        '--no-autoupdate',
        '--metrics',
        '127.0.0.1:0',
      ])

      await provider.stop()
      expect(provider.snapshot().status).toBe('stopped')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
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
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: () => {},
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.tail().includes('before'), { description: 'first log line' })
      const received: string[] = []
      provider.subscribeToLogs((line) => received.push(line))
      await waitFor(() => received.includes('after'), { description: 'future log line' })

      expect(received).toEqual(['after'])
      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('flips to permanently-failed with restart guidance when the cloudflared binary is missing', async () => {
    const scratchDir = createScratchDir()
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary: join(scratchDir, 'cloudflared-does-not-exist'),
      onUrlChange: () => {},
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      const snap = provider.snapshot()
      expect(snap.status).toBe('permanently-failed')
      expect(snap.detail).toContain('docker.file.cloudflared')
      expect(snap.detail).toContain('typeclaw restart')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('restarts a crashed process with backoff until a URL is emitted', async () => {
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
echo "https://after-restart.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const urls: string[] = []
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: (url) => urls.push(url),
      probeUpstream: async () => true,
      restartBackoffMs: [5],
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => urls.length === 1, { description: 'URL after restart' })

      expect(await readFile(countFile, 'utf8')).toBe('2')
      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy after restart probe' })
      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('stops retrying after the failure cap is reached before any URL is emitted', async () => {
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
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: () => {},
      restartBackoffMs: [1],
      maxConsecutiveFailuresWithoutUrl: 2,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'permanently-failed', { description: 'permanent failure' })

      expect(await readFile(countFile, 'utf8')).toBe('2')
      await provider.stop()
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
echo "https://stubborn.trycloudflare.com" >&2
trap '' TERM
sleep 30
`,
    )
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: () => {},
      probeUpstream: async () => true,
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy tunnel' })

      await provider.stop()

      expect(provider.snapshot().status).toBe('stopped')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('broadcasts the URL but stays unhealthy when the upstream is unreachable', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "https://no-upstream.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const urls: string[] = []
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 4851,
      binary,
      onUrlChange: (url) => urls.push(url),
      probeUpstream: async () => false,
      upstreamRecheckMs: 5,
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'unhealthy', { description: 'unhealthy on dead upstream' })

      expect(urls).toEqual(['https://no-upstream.trycloudflare.com'])
      const snap = provider.snapshot()
      expect(snap.url).toBe('https://no-upstream.trycloudflare.com')
      expect(snap.detail).toContain('4851')
      expect(snap.detail).toContain('502')
      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('flips to healthy on recheck once the upstream comes up', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "https://slow-upstream.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    let upstreamReady = false
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 4851,
      binary,
      onUrlChange: () => {},
      probeUpstream: async () => upstreamReady,
      upstreamRecheckMs: 5,
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().status === 'unhealthy', { description: 'unhealthy before upstream' })

      upstreamReady = true
      await waitFor(() => provider.snapshot().status === 'healthy', { description: 'healthy after upstream comes up' })
      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('does not mark healthy when a probe resolves after cloudflared has already exited', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "https://exited.trycloudflare.com" >&2
exit 1
`,
    )
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    let probeStarted = false
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 4851,
      binary,
      onUrlChange: () => {},
      // Probe blocks until released; by then the process has exited and the
      // tunnel is in restart backoff. A reachable result must NOT win.
      probeUpstream: async () => {
        probeStarted = true
        await probeGate
        return true
      },
      restartBackoffMs: [30_000],
      upstreamRecheckMs: 5,
      stopGraceMs: 10,
    })

    try {
      await provider.start()
      await waitFor(() => probeStarted, { description: 'probe started' })
      await waitFor(() => provider.snapshot().detail.includes('restarting'), { description: 'restart backoff entered' })

      releaseProbe()
      await Bun.sleep(20)

      const snap = provider.snapshot()
      expect(snap.status).not.toBe('healthy')
      expect(snap.detail).toContain('restarting')
      await provider.stop()
    } finally {
      releaseProbe()
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
