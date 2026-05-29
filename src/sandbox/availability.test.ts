import { afterEach, describe, expect, test } from 'bun:test'

import { _resetBwrapAvailabilityCacheForTests, ensureBwrapAvailable } from './availability'
import { SandboxUnavailableError } from './errors'

afterEach(() => {
  _resetBwrapAvailabilityCacheForTests()
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
