import { describe, expect, test } from 'bun:test'

import { wslDriveMount, type WslDriveMountDeps } from './checks'
import type { CheckContext } from './types'

const agentCtx: CheckContext = { cwd: '/mnt/c/work/agent', hasAgentFolder: true }
const linuxCtx: CheckContext = { cwd: '/home/dev/agent', hasAgentFolder: true }

function deps(overrides: Partial<WslDriveMountDeps> = {}): WslDriveMountDeps {
  return {
    detect: () => ({ isWsl: true, version: 2 }),
    isWindowsDriveMount: (p) => p.startsWith('/mnt/'),
    typeclawHome: () => '/home/dev/.typeclaw',
    ...overrides,
  }
}

describe('wslDriveMount', () => {
  test('passes when not running under WSL', async () => {
    const check = wslDriveMount(deps({ detect: () => ({ isWsl: false, version: null }) }))
    const result = await check.run(agentCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running under WSL')
  })

  test('passes when agent folder and home are on the Linux filesystem', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
  })

  test('warns when the agent folder is on a Windows-drive mount', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(agentCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: /mnt/c/work/agent')
    expect(result.fix?.description).toContain('Linux filesystem')
  })

  test('warns when ~/.typeclaw is on a Windows-drive mount even if agent folder is fine', async () => {
    const winHome = '/mnt/c/work/.typeclaw'
    const check = wslDriveMount(deps({ typeclawHome: () => winHome }))
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain(`hostd home: ${winHome}`)
  })

  test('does not inspect the agent folder when there is none', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run({ cwd: '/mnt/c/work/agent', hasAgentFolder: false })
    expect(result.status).toBe('ok')
  })
})
