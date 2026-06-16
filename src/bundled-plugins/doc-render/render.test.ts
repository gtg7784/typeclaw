import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { COMPILER_PACKAGE, COMPILER_VERSION, isModuleNotFound, missingCompilerGuidance } from './render'

describe('isModuleNotFound', () => {
  test.each([
    'Cannot find package "@myriaddreamin/typst-ts-node-compiler"',
    'Cannot find module "x"',
    'error: Module not found "y"',
    `something mentioning ${COMPILER_PACKAGE} directly`,
  ])('treats Bun resolution failure %j as a missing module', (message) => {
    expect(isModuleNotFound(message)).toBe(true)
  })

  test('does not flag an unrelated runtime error', () => {
    expect(isModuleNotFound('TypeError: x is not a function')).toBe(false)
  })
})

describe('missingCompilerGuidance', () => {
  test('names the exact pinned bun add command', () => {
    const guidance = missingCompilerGuidance()
    expect(guidance).toContain(`bun add ${COMPILER_PACKAGE}@${COMPILER_VERSION}`)
  })

  test('forbids the ad-hoc fallback libraries that agents reach for', () => {
    const guidance = missingCompilerGuidance()
    expect(guidance).toMatch(/jsPDF/)
    expect(guidance).toMatch(/pdfkit/)
    expect(guidance).toMatch(/ReportLab/)
  })
})

describe('render script CLI', () => {
  const scriptPath = fileURLToPath(new URL('./render.ts', import.meta.url))

  test('exits 2 with usage when args are missing', async () => {
    const proc = Bun.spawn(['bun', 'run', scriptPath], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    expect(proc.exitCode).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain('usage:')
  })

  // The "compiler absent" exit-3 path can't be exercised reliably in a unit test:
  // Bun.resolveSync auto-installs/resolves the pinned package from its global
  // cache on a dev machine, so a spawned render never sees the missing-module
  // error here. The error ROUTING is covered deterministically by the
  // isModuleNotFound + missingCompilerGuidance tests above, and the end-to-end
  // exit-3 behavior is exercised in a fresh container where the cache is empty.
})

describe('compiler resolution from a nested document directory', () => {
  test('Bun.resolveSync walks up from a deep cwd to the agent-root node_modules', async () => {
    // Mirrors production: the package lives in the agent root's node_modules, the
    // agent runs the render from a nested doc dir (workspace/, public/sub/, ...),
    // and resolution must walk UP to find it. This is the load-bearing assumption
    // behind resolving against process.cwd() rather than the script's own dir.
    const root = mkdtempSync(join(tmpdir(), 'doc-render-resolve-'))
    const pkgDir = join(root, 'node_modules', 'fake-renderer')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), '{"name":"fake-renderer","main":"index.js"}')
    await writeFile(join(pkgDir, 'index.js'), 'module.exports = {}')

    const docDir = join(root, 'public', 'reports', 'q2')
    await mkdir(docDir, { recursive: true })

    const resolved = Bun.resolveSync('fake-renderer', docDir)
    expect(resolved).toMatch(/[\\/]node_modules[\\/]fake-renderer[\\/]index\.js$/)
  })
})
