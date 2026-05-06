import { describe, expect, test } from 'bun:test'

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
}

describe('installShim', () => {
  test('replaces an upstream symlink with an absolute-target stash so the link still resolves', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', {
      kind: 'symlink',
      target: '../../../root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js',
    })

    const result = installShim({
      binPath: '/usr/local/bin/agent-browser',
      shimEntry: '/agent/node_modules/typeclaw/plugins/agent-browser/shim.ts',
      fs: fake.fs(),
    })

    expect(result.kind).toBe('installed')
    if (result.kind !== 'installed') throw new Error('unreachable')
    expect(result.binPath).toBe('/usr/local/bin/agent-browser')
    expect(result.realBin).toBe('/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js')

    expect(fake.events).toContain('unlink:/usr/local/bin/agent-browser')
    expect(fake.events).toContain(
      'symlink:/usr/local/lib/typeclaw-agent-browser/agent-browser-real->/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser.js',
    )
    const stash = fake.files.get('/usr/local/lib/typeclaw-agent-browser/agent-browser-real')
    if (!stash || stash.kind !== 'symlink') throw new Error('stash not a symlink')
    expect(stash.target.startsWith('/')).toBe(true)

    const wrapper = fake.files.get('/usr/local/bin/agent-browser')
    if (!wrapper || wrapper.kind !== 'file') throw new Error('wrapper not written')
    expect(wrapper.mode).toBe(0o755)
    expect(wrapper.data).toContain('TYPECLAW_AGENT_BROWSER_REAL_BIN')
    expect(wrapper.data).toContain('/usr/local/lib/typeclaw-agent-browser/agent-browser-real')
    expect(wrapper.data).toContain('exec bun run /agent/node_modules/typeclaw/plugins/agent-browser/shim.ts')
    expect(wrapper.data).toContain('# typeclaw-agent-browser-shim')
  })

  test('renames an upstream regular file aside (rare: future bun layouts may copy instead of symlink)', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', { kind: 'file', data: '#!/usr/bin/env node\n', mode: 0o755 })

    installShim({ binPath: '/usr/local/bin/agent-browser', shimEntry: '/x/shim.ts', fs: fake.fs() })

    expect(fake.events).toContain(
      'rename:/usr/local/bin/agent-browser->/usr/local/lib/typeclaw-agent-browser/agent-browser-real',
    )
  })

  test('is idempotent: a second run sees the marker and short-circuits', () => {
    const fake = new FakeFs()
    fake.files.set('/usr/local/bin/agent-browser', {
      kind: 'symlink',
      target: '/some/upstream/bin',
    })

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
})
