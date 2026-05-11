import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectMissingDeps, ensureDepsInstalled } from './ensure-deps'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-ensure-deps-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(content, null, 2)}\n`)
}

async function installFakeDep(name: string, content: Record<string, unknown> = {}): Promise<void> {
  await writePackageJson(join(root, 'node_modules', name), { name, version: '1.0.0', ...content })
}

describe('detectMissingDeps', () => {
  test('returns empty when every declared direct dep is installed', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('reports missing direct deps by name', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0', other: '^1' } })
    await installFakeDep('typeclaw')

    expect(await detectMissingDeps(root)).toEqual(['other'])
  })

  test('reports a transitive dep missing when the installed direct dep declares it', async () => {
    // given: agent declares typeclaw; typeclaw is installed; typeclaw's package.json
    // declares zod as a dep; zod is NOT installed at the root (the canonical bug).
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })

    expect(await detectMissingDeps(root)).toEqual(['zod'])
  })

  test('does not report a transitive dep that IS hoisted', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })
    await installFakeDep('zod')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns empty when package.json declares no dependencies field', async () => {
    await writePackageJson(root, { name: 'agent' })

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns empty when the agent folder has no package.json at all', async () => {
    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('ignores an unreadable transitive package.json (no false positives from corrupt installs)', async () => {
    // given: typeclaw's package.json is invalid JSON. detectMissingDeps must
    // not throw — it should just skip that transitive walk. Otherwise a single
    // corrupted dep in node_modules/ would brick `typeclaw start`.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await mkdir(join(root, 'node_modules', 'typeclaw'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'typeclaw', 'package.json'), 'not json {{{')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns missing deps in sorted order (deterministic output for diagnostics)', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { c: '^1', a: '^1', b: '^1' } })

    expect(await detectMissingDeps(root)).toEqual(['a', 'b', 'c'])
  })
})

describe('ensureDepsInstalled', () => {
  test('runs install when drift is detected and reports installed=true', async () => {
    let installed = 0
    let detectCalls = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => {
        detectCalls++
        return detectCalls === 1 ? ['zod'] : []
      },
      install: async () => {
        installed++
        return { ok: true }
      },
    })

    expect(installed).toBe(1)
    expect(detectCalls).toBe(2)
    expect(result).toMatchObject({ ok: true, installed: true })
  })

  test('skips install when no drift is detected and reports installed=false', async () => {
    let installed = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => [],
      install: async () => {
        installed++
        return { ok: true }
      },
    })

    expect(installed).toBe(0)
    expect(result).toMatchObject({ ok: true, installed: false })
  })

  test('returns ok:false with the install reason when bun install fails', async () => {
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => ['zod'],
      install: async () => ({ ok: false, reason: 'lockfile is read-only' }),
    })

    expect(result).toEqual({ ok: false, reason: 'lockfile is read-only', missing: ['zod'] })
  })

  test('returns ok:false when install succeeds but deps are still missing afterward', async () => {
    // given: bun install returns 0, but the missing deps did not actually
    // appear. This is the file:-linked dep silent-no-op case the comment in
    // ensure-deps.ts calls out — we MUST surface this rather than proceeding
    // to docker run with a broken node_modules.
    let calls = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => {
        calls++
        return ['zod']
      },
      install: async () => ({ ok: true }),
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      ok: false,
      missing: ['zod'],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('still missing')
    expect(result.reason).toContain('zod')
  })

  test('detects drift end-to-end through the real filesystem (no detect injection)', async () => {
    // given: a real agent folder where typeclaw is installed but its declared
    // zod dep is not. This exercises the actual detectMissingDeps path, so a
    // regression that breaks fs-level detection fails this test.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })

    let installed = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      install: async () => {
        installed++
        await installFakeDep('zod')
        return { ok: true }
      },
    })

    expect(installed).toBe(1)
    expect(result).toMatchObject({ ok: true, installed: true })
  })
})
