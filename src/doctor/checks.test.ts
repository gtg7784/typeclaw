import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfigSync } from '@/config'
import { resolveBaseImageVersion } from '@/init/cli-version'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import {
  buildStaticChecks,
  windowsSecretPerms,
  wslDriveMount,
  type WindowsSecretPermsDeps,
  type WslDriveMountDeps,
} from './checks'
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

describe('windowsSecretPerms', () => {
  function winDeps(overrides: Partial<WindowsSecretPermsDeps> = {}): WindowsSecretPermsDeps {
    return {
      isWindows: () => true,
      typeclawHome: () => 'C:\\Users\\dev\\.typeclaw',
      ...overrides,
    }
  }

  test('passes when not on native Windows', async () => {
    const check = windowsSecretPerms({ isWindows: () => false })
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on native Windows')
  })

  test('warns on native Windows that file modes are not enforced', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: C:\\work\\agent')
    expect(result.details?.some((d) => d.includes('NTFS'))).toBe(true)
  })

  test('reports the hostd home even without an agent folder', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: false })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('hostd home: C:\\Users\\dev\\.typeclaw')
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'hostd.windows-secret-perms')).toBe(true)
  })
})

describe('managed-template checks tolerate CRLF line endings', () => {
  function findCheck(name: string) {
    const check = buildStaticChecks().find((c) => c.name === name)
    if (!check) throw new Error(`missing check ${name}`)
    return check
  }

  function makeAgentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-crlf-test-'))
    writeFileSync(join(dir, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    return dir
  }

  const ctx = (cwd: string): CheckContext => ({ cwd, hasAgentFolder: true })

  test('.gitignore with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildGitignore({ append: [] })
    writeFileSync(join(cwd, GITIGNORE_FILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.gitignore-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })

  test('Dockerfile with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildDockerfile(loadConfigSync(cwd).docker.file, {
      baseImageVersion: resolveBaseImageVersion(cwd),
    })
    writeFileSync(join(cwd, DOCKERFILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.dockerfile-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })
})
