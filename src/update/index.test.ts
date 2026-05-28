import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { formatCommand, planSelfUpdate, resolveSelfPackageJsonPath } from './index'

describe('planSelfUpdate', () => {
  test('detects a Bun global install and updates with bun', () => {
    const packageJsonPath = join('/home/alice', '.bun', 'install', 'global', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath })

    expect(plan).toEqual({
      ok: true,
      manager: 'bun',
      command: ['bun', 'update', '-g', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects an npm global install and updates with npm', () => {
    const packageJsonPath = join('/usr/local/lib', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath })

    expect(plan).toEqual({
      ok: true,
      manager: 'npm',
      command: ['npm', 'install', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('refuses local node_modules installs because updating a global package would be wrong', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath })

    expect(plan).toEqual({
      ok: false,
      reason:
        'Cannot auto-detect how TypeClaw was installed from this checkout. Re-run with --manager=bun or --manager=npm if you want to update a global install.',
    })
  })

  test('refuses auto mode from a source checkout because it is not a self update', () => {
    const packageJsonPath = join('/work', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath })

    expect(plan).toEqual({
      ok: false,
      reason:
        'Cannot auto-detect how TypeClaw was installed from this checkout. Re-run with --manager=bun or --manager=npm if you want to update a global install.',
    })
  })

  test('explicit manager overrides source-checkout detection', () => {
    const packageJsonPath = join('/work', 'typeclaw', 'package.json')

    expect(planSelfUpdate({ manager: 'bun', packageJsonPath })).toEqual({
      ok: true,
      manager: 'bun',
      command: ['bun', 'update', '-g', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
    expect(planSelfUpdate({ manager: 'npm', packageJsonPath })).toEqual({
      ok: true,
      manager: 'npm',
      command: ['npm', 'install', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })
})

describe('formatCommand', () => {
  test('shell-quotes arguments with spaces or shell metacharacters', () => {
    expect(formatCommand(['npm', 'install', '-g', 'typeclaw@latest'])).toBe('npm install -g typeclaw@latest')
    expect(formatCommand(['cmd', 'two words', "can't"])).toBe(`cmd 'two words' 'can'\\''t'`)
  })
})

describe('resolveSelfPackageJsonPath', () => {
  test('points at this package manifest', () => {
    expect(resolveSelfPackageJsonPath()).toEndWith(join('typeclaw', 'package.json'))
  })
})
