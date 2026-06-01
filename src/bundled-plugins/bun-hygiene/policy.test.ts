import { describe, expect, test } from 'bun:test'

import { ACKNOWLEDGE_GUARDS } from '../guard/policy'
import { GUARD_GLOBAL_INSTALL, GUARD_NON_BUN_PACKAGE_MANAGER, checkBunHygieneGuard } from './policy'

function bash(command: string, extra: Record<string, unknown> = {}) {
  return checkBunHygieneGuard({ tool: 'bash', args: { command, ...extra } })
}

describe('checkBunHygieneGuard — global installs', () => {
  test.each([
    'npm install -g typescript',
    'npm i -g typescript',
    'npm install --global typescript',
    'npm -g install typescript',
    'pnpm add -g typescript',
    'pnpm add --global typescript',
    'yarn global add typescript',
    'bun add -g typescript',
    'bun install -g typescript',
    'bun add --global typescript',
    'npm install -gD typescript',
    'sudo npm install -g typescript',
    'env FOO=bar npm install -g typescript',
  ])('blocks %p', (command) => {
    const result = bash(command)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })

  test('block reason guides toward bun add / bunx', () => {
    const result = bash('npm install -g typescript')
    expect(result?.reason).toContain('bun add')
    expect(result?.reason).toContain('bunx')
  })

  test('acknowledging globalInstall lets it through', () => {
    const result = bash('npm install -g typescript', {
      [ACKNOWLEDGE_GUARDS]: { [GUARD_GLOBAL_INSTALL]: true },
    })
    expect(result).toBeUndefined()
  })
})

describe('checkBunHygieneGuard — non-bun package managers', () => {
  test.each([
    'npm install',
    'npm run build',
    'npx create-next-app',
    'pnpm install',
    'pnpx cowsay hi',
    'yarn',
    'yarn add lodash',
    'cd app && npm install',
    'echo done; npx tsc',
  ])('blocks %p', (command) => {
    const result = bash(command)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
  })

  test('acknowledging nonBunPackageManager lets it through', () => {
    const result = bash('npm install', {
      [ACKNOWLEDGE_GUARDS]: { [GUARD_NON_BUN_PACKAGE_MANAGER]: true },
    })
    expect(result).toBeUndefined()
  })

  // A global install is the more specific violation: acknowledging it must not
  // also require acknowledging nonBunPackageManager for the same command.
  test('global install takes precedence over the non-bun guard', () => {
    expect(bash('npm install -g typescript')?.reason).toContain(GUARD_GLOBAL_INSTALL)
    const acknowledged = bash('npm install -g typescript', {
      [ACKNOWLEDGE_GUARDS]: { [GUARD_GLOBAL_INSTALL]: true },
    })
    expect(acknowledged).toBeUndefined()
  })
})

describe('checkBunHygieneGuard — allowed commands', () => {
  test.each([
    'bun install',
    'bun add lodash',
    'bun add -d typescript',
    'bunx tsc',
    'bunx create-next-app my-app',
    'bun run build',
    'ls -g',
    './npm-wrapper.sh',
    'echo "npm install -g foo"',
    'cat npm-debug.log',
    'git commit -m "switch from npm to bun"',
    'my-npm-tool --global',
    'grep -rn npx src/',
  ])('allows %p', (command) => {
    expect(bash(command)).toBeUndefined()
  })
})

describe('checkBunHygieneGuard — non-bash tools', () => {
  test('ignores non-bash tools', () => {
    expect(checkBunHygieneGuard({ tool: 'write', args: { command: 'npm install -g x' } })).toBeUndefined()
  })

  test('ignores missing command arg', () => {
    expect(checkBunHygieneGuard({ tool: 'bash', args: {} })).toBeUndefined()
  })
})
