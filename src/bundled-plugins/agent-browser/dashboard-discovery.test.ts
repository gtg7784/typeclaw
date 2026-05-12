import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverDashboardPort, type ProcFs } from './dashboard-discovery'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tc-discovery-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fakeFetcher(byPort: Record<number, { ok: boolean }>): typeof fetch {
  const impl = async (input: URL | RequestInfo) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const match = url.match(/:(\d+)\//)
    if (!match) throw new Error('unexpected fetch url: ' + url)
    const port = Number(match[1])
    const cfg = byPort[port]
    if (!cfg) throw new Error(`ECONNREFUSED ${port}`)
    return new Response('', { status: cfg.ok ? 200 : 500 })
  }
  return impl as unknown as typeof fetch
}

function fakeProcFs(opts: {
  pids: Set<number>
  inodesByPid: Map<number, Set<string>>
  sockets: Array<{ port: number; inode: string }>
}): ProcFs {
  return {
    pidExists: (pid) => opts.pids.has(pid),
    listenInodesForPid: (pid) => opts.inodesByPid.get(pid) ?? new Set(),
    listenSockets: () => opts.sockets,
  }
}

describe('discoverDashboardPort', () => {
  test('returns hint file port when it points at a live dashboard', async () => {
    const hintPath = join(tmp, 'hint')
    writeFileSync(hintPath, '4849')

    const port = await discoverDashboardPort({
      hintPath,
      pidPath: join(tmp, 'no-pid'),
      fetchImpl: fakeFetcher({ 4849: { ok: true } }),
      procfs: fakeProcFs({ pids: new Set(), inodesByPid: new Map(), sockets: [] }),
    })

    expect(port).toBe(4849)
  })

  test('falls back to procfs when hint port no longer responds', async () => {
    const hintPath = join(tmp, 'hint')
    const pidPath = join(tmp, 'pid')
    writeFileSync(hintPath, '4849')
    writeFileSync(pidPath, '42')

    const port = await discoverDashboardPort({
      hintPath,
      pidPath,
      fetchImpl: fakeFetcher({ 7777: { ok: true } }),
      procfs: fakeProcFs({
        pids: new Set([42]),
        inodesByPid: new Map([[42, new Set(['1001'])]]),
        sockets: [{ port: 7777, inode: '1001' }],
      }),
    })

    expect(port).toBe(7777)
  })

  test('drops the proxy port from the candidate list', async () => {
    const pidPath = join(tmp, 'pid')
    writeFileSync(pidPath, '42')

    const port = await discoverDashboardPort({
      hintPath: join(tmp, 'no-hint'),
      pidPath,
      excludePort: 4848,
      fetchImpl: fakeFetcher({ 9999: { ok: true } }),
      procfs: fakeProcFs({
        pids: new Set([42]),
        inodesByPid: new Map([[42, new Set(['1001', '1002'])]]),
        sockets: [
          { port: 4848, inode: '1001' },
          { port: 9999, inode: '1002' },
        ],
      }),
    })

    expect(port).toBe(9999)
  })

  test('returns null when pidfile is stale (pid not alive)', async () => {
    const pidPath = join(tmp, 'pid')
    writeFileSync(pidPath, '42')

    const port = await discoverDashboardPort({
      hintPath: join(tmp, 'no-hint'),
      pidPath,
      fetchImpl: fakeFetcher({}),
      procfs: fakeProcFs({ pids: new Set(), inodesByPid: new Map(), sockets: [] }),
    })

    expect(port).toBeNull()
  })

  test('returns null when no candidate port responds', async () => {
    const pidPath = join(tmp, 'pid')
    writeFileSync(pidPath, '42')

    const port = await discoverDashboardPort({
      hintPath: join(tmp, 'no-hint'),
      pidPath,
      fetchImpl: fakeFetcher({}),
      procfs: fakeProcFs({
        pids: new Set([42]),
        inodesByPid: new Map([[42, new Set(['1001'])]]),
        sockets: [{ port: 7777, inode: '1001' }],
      }),
    })

    expect(port).toBeNull()
  })

  test('returns null when hint and pid file are both missing', async () => {
    const port = await discoverDashboardPort({
      hintPath: join(tmp, 'nope-hint'),
      pidPath: join(tmp, 'nope-pid'),
      fetchImpl: fakeFetcher({ 4849: { ok: true } }),
      procfs: fakeProcFs({ pids: new Set(), inodesByPid: new Map(), sockets: [] }),
    })

    expect(port).toBeNull()
  })

  test('rejects malformed hint file content (no probing)', async () => {
    const hintPath = join(tmp, 'hint')
    const pidPath = join(tmp, 'pid')
    writeFileSync(hintPath, 'not a port')
    writeFileSync(pidPath, '42')

    const probedPorts: number[] = []
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const match = url.match(/:(\d+)\//)
      if (match) probedPorts.push(Number(match[1]))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await discoverDashboardPort({
      hintPath,
      pidPath,
      fetchImpl: fetcher,
      procfs: fakeProcFs({
        pids: new Set([42]),
        inodesByPid: new Map([[42, new Set(['1001'])]]),
        sockets: [{ port: 9999, inode: '1001' }],
      }),
    })

    expect(probedPorts).not.toContain(NaN)
    expect(probedPorts).toContain(9999)
  })
})
