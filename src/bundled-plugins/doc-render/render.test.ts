import { describe, expect, test } from 'bun:test'

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
  const scriptPath = new URL('./render.ts', import.meta.url).pathname

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
