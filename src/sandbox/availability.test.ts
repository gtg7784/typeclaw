import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetBwrapAvailabilityCacheForTests,
  _resetRealProcProbeCacheForTests,
  canMountRealProc,
  ensureBwrapAvailable,
  resolveProcSelfExe,
} from './availability'
import { SandboxUnavailableError } from './errors'

afterEach(() => {
  _resetBwrapAvailabilityCacheForTests()
  _resetRealProcProbeCacheForTests()
})

describe('ensureBwrapAvailable', () => {
  test('throws SandboxUnavailableError when the binary does not exist', async () => {
    await expect(ensureBwrapAvailable({ bwrapPath: '/nonexistent/definitely-not-bwrap' })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    )
  })

  test('caches the negative result by path (second call still rejects)', async () => {
    const opts = { bwrapPath: '/nonexistent/definitely-not-bwrap' }
    await expect(ensureBwrapAvailable(opts)).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(ensureBwrapAvailable(opts)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  // bwrap is present in the typeclaw container but not on the macOS dev host,
  // so this asserts the positive path only where the binary actually exists.
  // Bun.spawnSync THROWS on a missing binary (ENOENT) rather than returning
  // success:false, so the probe itself must be guarded.
  const bwrapPresent = (() => {
    try {
      return Bun.spawnSync(['bwrap', '--version'], { stdout: 'ignore', stderr: 'ignore' }).success
    } catch {
      return false
    }
  })()
  test.skipIf(!bwrapPresent)('resolves when bwrap is on PATH', async () => {
    await expect(ensureBwrapAvailable()).resolves.toBeUndefined()
  })
})

describe('canMountRealProc', () => {
  // The probe's boolean depends on the host kernel/runtime (true only where
  // `unshare --mount-proc` actually works — a Linux container with real
  // CAP_SYS_ADMIN; false on the macOS dev host where `unshare` is absent). So
  // these assert the contract that survives both environments: the result is
  // a boolean, and it is stable/cached within a process lifetime.
  test('returns a boolean', async () => {
    expect(typeof (await canMountRealProc())).toBe('boolean')
  })

  test('caches the result (repeated calls return the same value)', async () => {
    const first = await canMountRealProc()
    const second = await canMountRealProc()
    expect(second).toBe(first)
  })

  test('re-probes after a cache reset', async () => {
    const before = await canMountRealProc()
    _resetRealProcProbeCacheForTests()
    const after = await canMountRealProc()
    // Same host, so the value is identical — but the call path went through a
    // fresh probe rather than the cache (no throw, deterministic).
    expect(after).toBe(before)
  })
})

describe('resolveProcSelfExe', () => {
  // The /proc/self/exe re-expose is bun-only by design (the container has no
  // real node; node/bunx/npx/pnpx all resolve to bun). Asserting it returns the
  // running bun binary pins that contract: if it ever returned something else,
  // sandboxed self-location would point at the wrong ELF.
  test('returns the running bun binary (process.execPath)', () => {
    expect(resolveProcSelfExe()).toBe(process.execPath)
    expect(resolveProcSelfExe()).toMatch(/bun/i)
  })
})
