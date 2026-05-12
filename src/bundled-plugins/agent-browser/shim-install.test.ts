import { describe, expect, test } from 'bun:test'
import { resolve as resolvePath } from 'node:path'

import { installShim, type ShimFs } from './shim-install'

type FakeFile = { kind: 'file'; data: string; mode: number } | { kind: 'symlink'; target: string }

class FakeFs {
  files = new Map<string, FakeFile>()
  events: string[] = []

  fs(): ShimFs {
    return {
      lstat: (path) => {
        const file = this.files.get(path)
        if (!file) return null
        return { isSymbolicLink: () => file.kind === 'symlink' }
      },
      statExists: (path) => this.resolveLink(path, 0) !== null,
      readlink: (path) => {
        const file = this.files.get(path)
        if (!file || file.kind !== 'symlink') throw new Error(`not a symlink: ${path}`)
        return file.target
      },
      readFile: (path) => {
        const file = this.files.get(path)
        if (!file || file.kind !== 'file') throw new Error(`not a file: ${path}`)
        return file.data
      },
      rename: (from, to) => {
        const file = this.files.get(from)
        if (!file) throw new Error(`missing: ${from}`)
        this.files.delete(from)
        this.files.set(to, file)
        this.events.push(`rename:${from}->${to}`)
      },
      symlink: (target, path) => {
        this.files.set(path, { kind: 'symlink', target })
        this.events.push(`symlink:${path}->${target}`)
      },
      writeFile: (path, data, mode) => {
        this.files.set(path, { kind: 'file', data, mode })
        this.events.push(`write:${path}:${mode.toString(8)}`)
      },
      unlink: (path) => {
        this.files.delete(path)
        this.events.push(`unlink:${path}`)
      },
      mkdirp: (path) => {
        this.events.push(`mkdirp:${path}`)
      },
    }
  }

  // Models POSIX stat() symlink-following: walks the chain and reports
  // whether it terminates at a real file. Bounded to break cycles, matching
  // the kernel's ELOOP behavior.
  private resolveLink(path: string, depth: number): FakeFile | null {
    if (depth > 32) return null
    const file = this.files.get(path)
    if (!file) return null
    if (file.kind !== 'symlink') return file
    const target = file.target.startsWith('/')
      ? file.target
      : resolvePath(path.split('/').slice(0, -1).join('/') || '/', file.target)
    return this.resolveLink(target, depth + 1)
  }
}

describe('installShim', () => {
  test('replaces an upstream symlink with an absolute-target stash so the link still resolves', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', {
      kind: 'symlink',
      target: '../../../root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js',
    })
    fake.files.set('/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js', {
      kind: 'file',
      data: '#!/usr/bin/env node\n',
      mode: 0o755,
    })

    const result = installShim({
      binPath: '/usr/local/bin/agent-browser',
      shimEntry: '/agent/node_modules/typeclaw/src/bundled-plugins/agent-browser/shim.ts',
      fs: fake.fs(),
    })

    expect(result.kind).toBe('installed')
    if (result.kind !== 'installed') throw new Error('unreachable')
    expect(result.binPath).toBe('/usr/local/bin/agent-browser')
    expect(result.realBin).toBe('/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js')

    expect(fake.events).toContain('unlink:/usr/local/bin/agent-browser')
    expect(result.stashTarget).toBe(
      '/usr/local/lib/typeclaw-agent-browser/usr-local-bin-agent-browser/agent-browser-real',
    )
    expect(fake.events).toContain(
      `symlink:${result.stashTarget}->/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js`,
    )
    const stash = fake.files.get(result.stashTarget)
    if (!stash || stash.kind !== 'symlink') throw new Error('stash not a symlink')
    expect(stash.target.startsWith('/')).toBe(true)

    const wrapper = fake.files.get('/usr/local/bin/agent-browser')
    if (!wrapper || wrapper.kind !== 'file') throw new Error('wrapper not written')
    expect(wrapper.mode).toBe(0o755)
    expect(wrapper.data).toContain('TYPECLAW_AGENT_BROWSER_REAL_BIN')
    expect(wrapper.data).toContain(result.stashTarget)
    expect(wrapper.data).toContain(
      'exec bun run /agent/node_modules/typeclaw/src/bundled-plugins/agent-browser/shim.ts',
    )
    expect(wrapper.data).toContain('# typeclaw-agent-browser-shim')
  })

  test('per-binPath stash directory keeps global and local installs from colliding', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', { kind: 'symlink', target: '/global/real' })
    fake.files.set('/global/real', { kind: 'file', data: 'global-bin', mode: 0o755 })
    fake.files.set('/agent/node_modules/.bin/agent-browser', { kind: 'symlink', target: '/local/real' })
    fake.files.set('/local/real', { kind: 'file', data: 'local-bin', mode: 0o755 })

    const global = installShim({ binPath: '/usr/local/bin/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })
    const local = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })

    if (global.kind !== 'installed' || local.kind !== 'installed') throw new Error('expected both installed')
    expect(global.stashTarget).not.toBe(local.stashTarget)
    expect(global.realBin).toBe('/global/real')
    expect(local.realBin).toBe('/local/real')
  })

  test('renames an upstream regular file aside (rare: future bun layouts may copy instead of symlink)', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', { kind: 'file', data: '#!/usr/bin/env node\n', mode: 0o755 })

    const result = installShim({ binPath: '/usr/local/bin/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })

    if (result.kind !== 'installed') throw new Error('expected installed')
    expect(fake.events).toContain(`rename:/usr/local/bin/agent-browser->${result.stashTarget}`)
  })

  test('re-installs after host-side bun install restored the original symlink (idempotent re-shim)', () => {
    const fake = new FakeFs()
    fake.files.set('/agent/node_modules/.bin/agent-browser', {
      kind: 'symlink',
      target: '../agent-browser/bin/agent-browser.js',
    })
    fake.files.set('/agent/node_modules/agent-browser/bin/agent-browser.js', {
      kind: 'file',
      data: '#!/usr/bin/env node\n',
      mode: 0o755,
    })

    const first = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })
    expect(first.kind).toBe('installed')

    fake.files.set('/agent/node_modules/.bin/agent-browser', {
      kind: 'symlink',
      target: '../agent-browser/bin/agent-browser.js',
    })

    const second = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })

    expect(second.kind).toBe('installed')
  })

  test('is idempotent: a second run sees the marker and short-circuits', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', {
      kind: 'symlink',
      target: '/some/upstream/bin',
    })
    fake.files.set('/some/upstream/bin', { kind: 'file', data: 'real', mode: 0o755 })

    installShim({ binPath: '/usr/local/bin/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })
    fake.events.length = 0

    const second = installShim({ binPath: '/usr/local/bin/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })

    expect(second.kind).toBe('already-installed')
    expect(fake.events).toEqual([])
  })

  test('returns no-upstream when nothing is at the bin path', () => {
    const fake = new FakeFs()

    const result = installShim({ binPath: '/nope/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })

    expect(result.kind).toBe('no-upstream')
    expect(fake.events).toEqual([])
  })

  test('returns no-upstream when binPath is a dangling symlink, leaving the filesystem untouched', () => {
    // Reproduces the production bug: host bun install creates
    // /agent/node_modules/.bin/agent-browser pointing into a node_modules
    // tree that doesn't exist inside the container. lstat sees the link
    // entry and used to proceed; now we follow the link and bail.
    const fake = new FakeFs()
    fake.files.set('/agent/node_modules/.bin/agent-browser', {
      kind: 'symlink',
      target: '../agent-browser/bin/agent-browser.js',
    })

    const result = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })

    expect(result.kind).toBe('no-upstream')
    expect(fake.events).toEqual([])
    const entry = fake.files.get('/agent/node_modules/.bin/agent-browser')
    if (!entry || entry.kind !== 'symlink') throw new Error('original symlink was mutated')
    expect(entry.target).toBe('../agent-browser/bin/agent-browser.js')
  })

  test('self-heals stale wrapper when stash target is missing', () => {
    // Container restart wipes the image-owned STASH_ROOT but leaves the
    // bind-mounted wrapper intact. Without self-heal, isAlreadyShim would
    // short-circuit and the wrapper would ENOENT every invocation forever.
    const fake = new FakeFs()
    fake.files.set('/agent/node_modules/.bin/agent-browser', {
      kind: 'symlink',
      target: '../agent-browser/bin/agent-browser.js',
    })
    fake.files.set('/agent/node_modules/agent-browser/bin/agent-browser.js', {
      kind: 'file',
      data: '#!/usr/bin/env node\n',
      mode: 0o755,
    })

    const first = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })
    if (first.kind !== 'installed') throw new Error('expected initial install to succeed')

    fake.files.delete(first.stashTarget)
    fake.events.length = 0

    const second = installShim({
      binPath: '/agent/node_modules/.bin/agent-browser',
      shimEntry: '/x/shim.ts',
      fs: fake.fs(),
    })

    expect(second.kind).toBe('no-upstream')
    expect(fake.events).toEqual(['unlink:/agent/node_modules/.bin/agent-browser'])
    expect(fake.files.has('/agent/node_modules/.bin/agent-browser')).toBe(false)
  })
})
