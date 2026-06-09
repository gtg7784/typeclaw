import { describe, expect, test } from 'bun:test'

import { commandNeedsRealProc, isPackageInstallCommand } from './package-install'

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

describe('commandNeedsRealProc', () => {
  test('flags package installs (add / install / i)', () => {
    expect(commandNeedsRealProc('bun add @googleworkspace/cli')).toBe(true)
    expect(commandNeedsRealProc('bun install')).toBe(true)
    expect(commandNeedsRealProc('bun i lodash')).toBe(true)
  })

  test('flags the package runners bunx, bun x, bun create', () => {
    expect(commandNeedsRealProc('bunx cowsay hi')).toBe(true)
    expect(commandNeedsRealProc('bunx')).toBe(true)
    expect(commandNeedsRealProc('bun x cowsay')).toBe(true)
    expect(commandNeedsRealProc('bun create vite my-app')).toBe(true)
  })

  test('flags bun run (it can exec a package bin that reads /proc/self/fd)', () => {
    expect(commandNeedsRealProc('bun run build')).toBe(true)
    expect(commandNeedsRealProc('bun run scripts/render.ts a b')).toBe(true)
  })

  // DIAGNOSTIC, not a privilege gate: unlike isPackageInstallCommand it must still
  // fire through shell metacharacters, since the bun invocation still runs and
  // still needs a real /proc.
  test('fires even with chaining / metacharacters (the bun invocation still runs)', () => {
    expect(commandNeedsRealProc('bunx foo && echo done')).toBe(true)
    expect(commandNeedsRealProc('bun add foo; echo ok')).toBe(true)
    expect(commandNeedsRealProc('  bun   install  ')).toBe(true)
  })

  test('does not flag bun subcommands that do not exercise the package /proc path', () => {
    expect(commandNeedsRealProc('bun test')).toBe(false)
    expect(commandNeedsRealProc('bun --version')).toBe(false)
    expect(commandNeedsRealProc('bun')).toBe(false)
  })

  test('does not flag non-bun commands', () => {
    expect(commandNeedsRealProc('git status')).toBe(false)
    expect(commandNeedsRealProc('npm install')).toBe(false)
    expect(commandNeedsRealProc('echo bunx not-really')).toBe(false)
  })
})
