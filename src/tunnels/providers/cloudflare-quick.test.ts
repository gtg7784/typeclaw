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
      stopGraceMs: 10,
      probeReady: async () => true,
    })

    try {
      await provider.start()
      await waitFor(() => urls.length === 1, { description: 'quick tunnel URL' })

      expect(urls).toEqual(['https://fake.trycloudflare.com'])
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
      probeReady: async () => true,
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
      restartBackoffMs: [5],
      stopGraceMs: 10,
      probeReady: async () => true,
    })

    try {
      await provider.start()
      await waitFor(() => urls.length === 1, { description: 'URL after restart' })

      expect(await readFile(countFile, 'utf8')).toBe('2')
      expect(provider.snapshot().status).toBe('healthy')
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
      probeReady: async () => true,
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
      stopGraceMs: 10,
      probeReady: async () => true,
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

  it('delays onUrlChange until the readiness probe succeeds', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "https://probe-pending.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const probeCalls: string[] = []
    let allowProbe = false
    const urls: string[] = []
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: (url) => urls.push(url),
      stopGraceMs: 10,
      probeBackoffMs: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      probeReady: async (url) => {
        probeCalls.push(url)
        return allowProbe
      },
    })

    try {
      await provider.start()
      await waitFor(() => probeCalls.length >= 2, { description: 'probe attempted at least twice' })

      expect(urls).toEqual([])
      expect(provider.snapshot()).toMatchObject({ status: 'starting', url: null })

      allowProbe = true
      await waitFor(() => urls.length === 1, { description: 'URL emitted after probe success' })

      expect(urls).toEqual(['https://probe-pending.trycloudflare.com'])
      expect(provider.snapshot()).toMatchObject({
        status: 'healthy',
        url: 'https://probe-pending.trycloudflare.com',
      })
      expect(probeCalls.every((u) => u === 'https://probe-pending.trycloudflare.com')).toBe(true)

      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('restarts cloudflared when the readiness probe never succeeds', async () => {
    const scratchDir = createScratchDir()
    const countFile = join(scratchDir, 'count.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
count=0
if [ -f "${countFile}" ]; then count=$(cat "${countFile}"); fi
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
echo "https://attempt-$count.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    const urls: string[] = []
    let allowProbe = false
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: (url) => urls.push(url),
      restartBackoffMs: [5],
      stopGraceMs: 10,
      probeBackoffMs: [5, 5],
      probeReady: async () => allowProbe,
    })

    try {
      await provider.start()
      await waitFor(() => Number(Bun.file(countFile).size) > 0, { description: 'first launch recorded' })
      await waitFor(async () => (await Bun.file(countFile).text()) === '2', {
        description: 'second launch after probe failure',
      })

      expect(urls).toEqual([])

      allowProbe = true
      await waitFor(() => urls.length === 1, { description: 'URL emitted after probe recovers' })
      expect(urls[0]?.startsWith('https://attempt-')).toBe(true)
      expect(provider.snapshot().status).toBe('healthy')

      await provider.stop()
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('cancels an in-flight readiness probe on stop()', async () => {
    const scratchDir = createScratchDir()
    const binary = installFakeCloudflared(
      scratchDir,
      `
echo "https://abort-me.trycloudflare.com" >&2
trap 'exit 0' TERM
sleep 30
`,
    )
    let probeAborted = false
    const provider = createCloudflareQuickProvider({
      config,
      upstreamPort: 8975,
      binary,
      onUrlChange: () => {},
      stopGraceMs: 10,
      probeBackoffMs: [5_000],
      probeReady: (_url, signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => {
            probeAborted = true
            resolve(false)
          })
        }),
    })

    try {
      await provider.start()
      await waitFor(() => provider.snapshot().detail === 'probing tunnel readiness', {
        description: 'probe started',
      })

      await provider.stop()

      expect(probeAborted).toBe(true)
      expect(provider.snapshot().status).toBe('stopped')
    } finally {
      await provider.stop()
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
