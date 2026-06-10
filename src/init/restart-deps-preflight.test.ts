import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateRestartDeps } from './restart-deps-preflight'

async function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'restart-preflight-'))
}

async function writePackage(dir: string, name: string, pkg: unknown): Promise<void> {
  const pkgDir = join(dir, 'packages', name)
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2))
}

describe('validateRestartDeps', () => {
  test('refuses when a workspace member pins a non-workspace dep via workspace:*', async () => {
    const cwd = await makeAgentDir()
    try {
      await writePackage(cwd, 'gws-multi-account', {
        name: 'gws-multi-account',
        dependencies: { typeclaw: 'workspace:*', zod: '^3.25.76' },
      })

      const result = await validateRestartDeps({ cwd, plugins: [] })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('typeclaw')
      expect(result.reason).toContain('workspace:*')
      expect(result.reason).toContain('gws-multi-account')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('allows workspace:* when the dep IS a workspace member', async () => {
    const cwd = await makeAgentDir()
    try {
      await writePackage(cwd, 'lib-core', { name: '@acme/core' })
      await writePackage(cwd, 'app', {
        name: 'app',
        dependencies: { '@acme/core': 'workspace:*' },
      })

      const result = await validateRestartDeps({ cwd, plugins: [] })

      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('allows a clean agent folder with registry-versioned deps', async () => {
    const cwd = await makeAgentDir()
    try {
      await writePackage(cwd, 'plugin-a', {
        name: 'plugin-a',
        dependencies: { typeclaw: '^0.36.1', zod: '^3.25.76' },
      })

      const result = await validateRestartDeps({ cwd, plugins: [] })

      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('allows when there is no packages/ directory at all', async () => {
    const cwd = await makeAgentDir()
    try {
      const result = await validateRestartDeps({ cwd, plugins: [] })
      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('skips (does not fail) a member with an unparseable manifest', async () => {
    const cwd = await makeAgentDir()
    try {
      const pkgDir = join(cwd, 'packages', 'broken')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(join(pkgDir, 'package.json'), '{ not valid json')

      const result = await validateRestartDeps({ cwd, plugins: [] })

      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('detects workspace:* in devDependencies and peerDependencies too', async () => {
    const cwd = await makeAgentDir()
    try {
      await writePackage(cwd, 'tooling', {
        name: 'tooling',
        devDependencies: { 'not-a-member': 'workspace:^1.0.0' },
      })

      const result = await validateRestartDeps({ cwd, plugins: [] })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('not-a-member')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('refuses when a local plugin path in typeclaw.json#plugins is missing', async () => {
    const cwd = await makeAgentDir()
    try {
      const result = await validateRestartDeps({ cwd, plugins: ['./packages/ghost'] })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('./packages/ghost')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('allows a local plugin path that exists on disk', async () => {
    const cwd = await makeAgentDir()
    try {
      await writePackage(cwd, 'real', { name: 'real' })

      const result = await validateRestartDeps({ cwd, plugins: ['./packages/real'] })

      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('ignores bare (registry) plugin names — those are not local-path checked', async () => {
    const cwd = await makeAgentDir()
    try {
      const result = await validateRestartDeps({ cwd, plugins: ['typeclaw-gws-multi-account@0.3.2'] })

      expect(result.ok).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('refuses an existing relative path that escapes the agent directory', async () => {
    const cwd = await makeAgentDir()
    try {
      // sibling.ts exists one level above cwd; a bare existsSync would pass, but
      // the loader confines local plugins to cwd and rejects this post-stop.
      const siblingFile = join(cwd, '..', 'sibling.ts')
      await writeFile(siblingFile, 'export default {}')

      const result = await validateRestartDeps({ cwd, plugins: ['../sibling.ts'] })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('escapes the agent directory')

      await rm(siblingFile, { force: true })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('refuses an existing absolute path outside the agent directory', async () => {
    const cwd = await makeAgentDir()
    const outsideDir = await makeAgentDir()
    try {
      const abs = join(outsideDir, 'plugin.ts')
      await writeFile(abs, 'export default {}')

      const result = await validateRestartDeps({ cwd, plugins: [abs] })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('escapes the agent directory')
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
