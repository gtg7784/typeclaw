import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isPackageNotFound, reconcilePluginDeps } from './reconcile-plugin-deps'

async function makeAgentDir(pkg: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-reconcile-'))
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return dir
}

async function readPkg(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

const neverResolve = async (name: string): Promise<string> => {
  throw new Error(`unexpected registry resolution for ${name}`)
}

describe('reconcilePluginDeps', () => {
  test('adds a versioned npm plugin to dependencies and records provenance', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: { typeclaw: '0.35.0' } })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.2.3')
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '1.2.3' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resolves a bare name to a pinned version once', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo'],
        resolveLatest: async () => '4.5.6',
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('4.5.6')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '4.5.6' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reuses the existing pin for a bare name instead of re-resolving latest', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    })
    try {
      // resolveLatest must NOT be called: an unchanged bare entry stays pinned.
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.0.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('prunes a managed dep when the plugin is removed from config', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { typeclaw: '0.35.0', 'typeclaw-plugin-foo': '1.2.3' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.2.3' } },
    })
    try {
      const result = await reconcilePluginDeps({ cwd: dir, plugins: [], resolveLatest: neverResolve })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBeUndefined()
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('never prunes a dep the user added that was not managed', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { typeclaw: '0.35.0', 'typeclaw-plugin-foo': '9.9.9' },
      typeclaw: {},
    })
    try {
      const result = await reconcilePluginDeps({ cwd: dir, plugins: [], resolveLatest: neverResolve })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('9.9.9')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('updates the pinned version when a managed plugin spec changes', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@2.0.0'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('2.0.0')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '2.0.0' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips local-path plugin entries', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['./plugins/local.ts', '../shared/plugin.ts', '/abs/plugin.ts'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect(pkg.dependencies).toEqual({})
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('handles scoped versioned entries', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      await reconcilePluginDeps({
        cwd: dir,
        plugins: ['@acme/typeclaw-plugin-foo@3.1.0'],
        resolveLatest: neverResolve,
      })
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['@acme/typeclaw-plugin-foo']).toBe('3.1.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is idempotent when config already matches package.json', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.2.3' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.2.3' } },
    })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns unchanged when package.json is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-reconcile-'))
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      expect(result.files).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips a bare-name plugin that does not exist in the registry and reports it', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: { typeclaw: '0.35.0' } })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['foo-bar'],
        resolveLatest: async () => null,
      })
      expect(result.skipped).toEqual(['foo-bar'])
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['foo-bar']).toBeUndefined()
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('still materializes resolvable plugins when a sibling plugin is not found', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['foo-bar', 'typeclaw-plugin-ok'],
        resolveLatest: async (name) => (name === 'foo-bar' ? null : '2.0.0'),
      })
      expect(result.changed).toBe(true)
      expect(result.skipped).toEqual(['foo-bar'])
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-ok']).toBe('2.0.0')
      expect((pkg.dependencies as Record<string, string>)['foo-bar']).toBeUndefined()
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-ok': '2.0.0' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('propagates a hard resolver failure instead of skipping (network errors still block)', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      await expect(
        reconcilePluginDeps({
          cwd: dir,
          plugins: ['typeclaw-plugin-foo'],
          resolveLatest: async () => {
            throw new Error('network down')
          },
        }),
      ).rejects.toThrow('network down')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isPackageNotFound', () => {
  test('treats registry 404 signals as not-found', () => {
    for (const stderr of [
      'error: package "foo-bar" not found',
      'GET https://registry.npmjs.org/foo-bar - 404 Not Found',
      'npm error code E404',
      '404 Not Found - GET https://registry.npmjs.org/foo-bar',
    ]) {
      expect(isPackageNotFound(stderr)).toBe(true)
    }
  })

  test('does NOT treat transient/auth failures as not-found', () => {
    for (const stderr of [
      'error: getaddrinfo ENOTFOUND registry.npmjs.org',
      'connect ETIMEDOUT 1.2.3.4:443',
      'npm error code E401 Unauthorized',
      'error: socket hang up',
      '',
    ]) {
      expect(isPackageNotFound(stderr)).toBe(false)
    }
  })
})
