import { describe, expect, test } from 'bun:test'

import { detectWslWith, isWindowsDriveMountWith, readAutomountRootWith, type WslProbes } from './wsl'

function makeProbes(overrides: Partial<WslProbes> = {}): WslProbes {
  return {
    platform: 'linux',
    kernelRelease: () => '5.15.0-generic',
    readFile: () => null,
    fileExists: () => false,
    env: {},
    ...overrides,
  }
}

describe('detectWslWith', () => {
  test('non-linux platform is never WSL', () => {
    expect(detectWslWith(makeProbes({ platform: 'win32' }))).toEqual({ isWsl: false, version: null })
    expect(detectWslWith(makeProbes({ platform: 'darwin' }))).toEqual({ isWsl: false, version: null })
  })

  test('native linux is not WSL', () => {
    const probes = makeProbes({
      kernelRelease: () => '6.5.0-generic',
      readFile: (p) => (p === '/proc/version' ? 'Linux version 6.5.0-generic (gcc ...)' : null),
    })
    expect(detectWslWith(probes)).toEqual({ isWsl: false, version: null })
  })

  test('detects WSL2 from microsoft-standard kernel release', () => {
    const probes = makeProbes({ kernelRelease: () => '5.15.90.1-microsoft-standard-WSL2' })
    expect(detectWslWith(probes)).toEqual({ isWsl: true, version: 2 })
  })

  test('detects WSL2 from /proc/version when kernel release is generic', () => {
    const probes = makeProbes({
      kernelRelease: () => '5.15.90.1',
      readFile: (p) => (p === '/proc/version' ? 'Linux version 5.15.90.1-microsoft-standard-WSL2 (...)' : null),
    })
    expect(detectWslWith(probes)).toEqual({ isWsl: true, version: 2 })
  })

  test('WSL_INTEROP env forces version 2 even without standard in kernel string', () => {
    const probes = makeProbes({
      kernelRelease: () => '5.10.0-microsoft',
      env: { WSL_INTEROP: '/run/WSL/8_interop' },
    })
    expect(detectWslWith(probes)).toEqual({ isWsl: true, version: 2 })
  })

  test('detects WSL1 from legacy Microsoft kernel (capital M, no standard)', () => {
    const probes = makeProbes({ kernelRelease: () => '4.4.0-19041-Microsoft' })
    expect(detectWslWith(probes)).toEqual({ isWsl: true, version: 1 })
  })

  test('custom kernel detected only via WSLInterop artifact has indeterminate version', () => {
    const probes = makeProbes({
      kernelRelease: () => '6.6.0-custom',
      readFile: (p) => (p === '/proc/version' ? 'Linux version 6.6.0-custom (...)' : null),
      fileExists: (p) => p === '/proc/sys/fs/binfmt_misc/WSLInterop',
    })
    expect(detectWslWith(probes)).toEqual({ isWsl: true, version: null })
  })

  test('detected via /run/WSL artifact alone', () => {
    const probes = makeProbes({
      kernelRelease: () => '6.6.0-custom',
      fileExists: (p) => p === '/run/WSL',
    })
    expect(detectWslWith(probes).isWsl).toBe(true)
  })
})

describe('readAutomountRootWith', () => {
  test('defaults to /mnt/ when wsl.conf is absent', () => {
    expect(readAutomountRootWith({ readFile: () => null })).toBe('/mnt/')
  })

  test('reads custom root from [automount] section and adds trailing slash', () => {
    const conf = '[automount]\nroot = /windir\nenabled = true\n'
    expect(readAutomountRootWith({ readFile: () => conf })).toBe('/windir/')
  })

  test('ignores root= outside the [automount] section', () => {
    const conf = '[network]\nroot = /not-this\n'
    expect(readAutomountRootWith({ readFile: () => conf })).toBe('/mnt/')
  })

  test('strips quotes and ignores comments', () => {
    const conf = '# comment\n[automount]\nroot = "/custom/"  # inline\n'
    expect(readAutomountRootWith({ readFile: () => conf })).toBe('/custom/')
  })
})

describe('isWindowsDriveMountWith', () => {
  const noConf = { readFile: () => null }

  test.each(['/mnt/c/agent', '/mnt/c', '/mnt/d/work', '/mnt/Z/x'])('flags Windows drive mount %p', (path) => {
    expect(isWindowsDriveMountWith(path, noConf)).toBe(true)
  })

  test.each(['/home/dev/agent', '/mnt/wsl/foo', '/mnt/wslg/bar', '/srv/data', '/mnt'])(
    'does not flag native path %p',
    (path) => {
      expect(isWindowsDriveMountWith(path, noConf)).toBe(false)
    },
  )

  test('respects a custom automount root from wsl.conf', () => {
    const conf = { readFile: () => '[automount]\nroot = /windir/\n' }
    expect(isWindowsDriveMountWith('/windir/c/agent', conf)).toBe(true)
    expect(isWindowsDriveMountWith('/mnt/c/agent', conf)).toBe(false)
  })
})
