import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { autoUpgradeTypeclawDep, describeAutoUpgrade, outcomeForcesInstall } from './auto-upgrade'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-auto-upgrade-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'package.json'), `${JSON.stringify(content, null, 2)}\n`)
}

async function writeInstalledTypeclaw(version: string): Promise<void> {
  const installDir = join(root, 'node_modules', 'typeclaw')
  await mkdir(installDir, { recursive: true })
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'typeclaw', version }))
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, 'package.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('autoUpgradeTypeclawDep', () => {
  test('returns skipped-dev-mode when scaffold version is null (running from typeclaw source repo)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: null })

    expect(outcome).toEqual({ kind: 'skipped-dev-mode' })
  })

  test('returns skipped-no-dep when package.json is absent', async () => {
    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep when package.json has no typeclaw dependency', async () => {
    await writePackageJson({ dependencies: { other: '^1.0.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-non-release-spec for file: / link: / dist-tag specs', async () => {
    for (const spec of ['file:../typeclaw', 'link:../typeclaw', 'latest', 'workspace:*', 'npm:typeclaw@0.1.0']) {
      await writePackageJson({ dependencies: { typeclaw: spec } })

      const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

      expect(outcome).toEqual({ kind: 'skipped-non-release-spec', declared: spec })
    }
  })

  test('returns up-to-date when installed version matches CLI version (caret range)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('returns up-to-date when installed version is AHEAD of CLI (never downgrades)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.5' } })
    await writeInstalledTypeclaw('0.1.5')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.5' })
  })

  test('returns reinstall-needed when installed is older than CLI but spec range allows CLI', async () => {
    // given: agent was bun-installed against typeclaw 0.1.0; CLI bumped to 0.1.2;
    //        the existing `^0.1.0` already permits 0.1.2 so no spec rewrite is needed.
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })

    // and: package.json was NOT modified (range still permits the new CLI)
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('^0.1.0')
  })

  test('rewrites spec when CLI version is OUT of range (pre-1.0 minor bump)', async () => {
    // given: agent pinned to ^0.1.0 (>=0.1.0 <0.2.0); CLI moved to 0.2.0
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0' })

    // and: package.json was rewritten with the new spec
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('^0.2.0')
  })

  test('rewrites spec when CLI crosses a major from ^1.x', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^1.5.0' } })
    await writeInstalledTypeclaw('1.5.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^2.0.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '^1.5.0', to: '^2.0.0' })
  })

  test('respects exact pin (no operator) without rewriting when CLI version differs', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })

    // and: spec was preserved exactly
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.1.0')
  })

  test('treats `=X.Y.Z` as an exact pin', async () => {
    await writePackageJson({ dependencies: { typeclaw: '=0.1.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'exact-pin-respected', declared: '=0.1.0', cliVersion: '0.1.2' })
  })

  test('exact pin matching CLI version → up-to-date (no warning, no rewrite)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.2' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('returns up-to-date when fresh agent has no node_modules yet but spec is in-range', async () => {
    // given: package.json exists, but bun install never ran. ensureDeps will
    //        install for the missing-dep reason — auto-upgrade has nothing to add.
    await writePackageJson({ dependencies: { typeclaw: '^0.1.2' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('tilde range that excludes CLI version triggers a rewrite', async () => {
    // given: ~0.1.2 → >=0.1.2 <0.2.0. CLI moved to 0.2.0 → out of range.
    await writePackageJson({ dependencies: { typeclaw: '~0.1.2' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '~0.1.2', to: '^0.2.0' })
  })

  test('tilde range that includes CLI version is treated like any in-range case', async () => {
    // given: ~0.1.0 → >=0.1.0 <0.2.0. CLI moved to 0.1.5 (still in range).
    await writePackageJson({ dependencies: { typeclaw: '~0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.5' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.5' })
  })

  test('preserves package.json formatting (key order, indentation) when rewriting spec', async () => {
    // Hand-craft a package.json with a specific layout and confirm the rewrite
    // touches ONLY the typeclaw spec value, leaving everything else byte-identical.
    const original = `{
  "name": "my-agent",
  "type": "module",
  "dependencies": {
    "typeclaw": "^0.1.0",
    "zod": "^4.0.0"
  }
}
`
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const after = await readFile(join(root, 'package.json'), 'utf8')
    expect(after).toBe(`{
  "name": "my-agent",
  "type": "module",
  "dependencies": {
    "typeclaw": "^0.2.0",
    "zod": "^4.0.0"
  }
}
`)
  })

  test('rejects a corrupt package.json by returning skipped-no-dep (never throws)', async () => {
    await writeFile(join(root, 'package.json'), '{ "name": "broken", "dependencies":')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('ignores an installed typeclaw whose version is a prerelease tag', async () => {
    // given: node_modules/typeclaw/package.json has 0.2.0-beta.1; spec is ^0.1.0;
    //        CLI is 0.1.2 (in range). The prerelease cannot be compared against
    //        the CLI as a release version — treat installed as absent.
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.2.0-beta.1')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })
})

describe('outcomeForcesInstall', () => {
  test('returns true only for outcomes that change what bun install must do', () => {
    expect(outcomeForcesInstall({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0' })).toBe(true)
    expect(outcomeForcesInstall({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })).toBe(true)

    expect(outcomeForcesInstall({ kind: 'up-to-date', installedVersion: '0.1.2' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-dev-mode' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-no-dep' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-non-release-spec', declared: 'latest' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })).toBe(false)
  })
})

describe('describeAutoUpgrade', () => {
  test('returns the upgrade line for spec-rewritten and reinstall-needed', () => {
    expect(describeAutoUpgrade({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0' })).toBe(
      'Upgrading agent typeclaw ^0.1.0 → ^0.2.0 to match CLI',
    )
    expect(describeAutoUpgrade({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })).toBe(
      'Upgrading agent typeclaw 0.1.0 → 0.1.2 to match CLI',
    )
  })

  test('returns the warning line for exact-pin-respected', () => {
    expect(describeAutoUpgrade({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })).toContain(
      'exact-pinned',
    )
  })

  test('returns empty string for no-op outcomes', () => {
    expect(describeAutoUpgrade({ kind: 'up-to-date', installedVersion: '0.1.2' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-dev-mode' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-no-dep' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-non-release-spec', declared: 'latest' })).toBe('')
  })
})
