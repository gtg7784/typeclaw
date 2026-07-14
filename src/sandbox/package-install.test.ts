import { describe, expect, test } from 'bun:test'

import { commandNeedsRealProc } from './package-install'

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

  // This diagnostic must fire through shell metacharacters because the Bun
  // invocation still runs and still needs a real /proc.
  test('fires even with chaining / metacharacters (the bun invocation still runs)', () => {
    expect(commandNeedsRealProc('bunx foo && echo done')).toBe(true)
    expect(commandNeedsRealProc('bun add foo; echo ok')).toBe(true)
    expect(commandNeedsRealProc('  bun   install  ')).toBe(true)
  })

  // The bun invocation can sit AFTER a prelude that just sets up the cwd; it still
  // runs under tmpfs /proc and still hits NotDir, so the diagnostic must catch a
  // bun command at any shell command boundary, not only as the first word.
  test('fires when bun runs after a chained prelude (cd / mkdir / pipe)', () => {
    expect(commandNeedsRealProc('cd /tmp/app && bun install')).toBe(true)
    expect(commandNeedsRealProc('mkdir app && cd app && bunx foo')).toBe(true)
    expect(commandNeedsRealProc('mkdir app; cd app; bunx foo')).toBe(true)
    expect(commandNeedsRealProc('cd app || bun add lodash')).toBe(true)
    expect(commandNeedsRealProc('(cd app && bun install)')).toBe(true)
    expect(commandNeedsRealProc('echo start\nbun run build')).toBe(true)
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
    expect(commandNeedsRealProc('cd /tmp && npm install')).toBe(false)
    expect(commandNeedsRealProc('cd bun && ls')).toBe(false)
  })
})
