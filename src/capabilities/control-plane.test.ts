import { describe, expect, test } from 'bun:test'

import { CONTROLLER_UNSUPPORTED_REASON } from '@/container'

import { createControlPlaneCapabilities } from './control-plane'

describe('createControlPlaneCapabilities', () => {
  // The noop's status() also returns { kind: 'missing' }, so a status-kind check
  // can't distinguish the controllers — prove the host one by observing it shell
  // out through the injected exec (the noop never touches exec).
  test('host profile yields the real controller (shells out via exec)', async () => {
    const calls: string[][] = []
    const caps = createControlPlaneCapabilities('host')
    await caps.controller.status({
      cwd: '/agent',
      exec: async (args) => {
        calls.push(args)
        return { exitCode: 1, stdout: '', stderr: 'no such container' }
      },
    })
    expect(calls.some((c) => c[0] === 'inspect')).toBe(true)
  })

  test('managed profile yields the fail-loud noop (does not shell out)', async () => {
    const calls: string[][] = []
    const caps = createControlPlaneCapabilities('managed')
    await caps.controller.status({
      cwd: '/agent',
      exec: async (args) => {
        calls.push(args)
        return { exitCode: 1, stdout: '', stderr: 'no such container' }
      },
    })
    const result = await caps.controller.stop({ cwd: '/agent' })

    expect(calls).toHaveLength(0)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })
})
