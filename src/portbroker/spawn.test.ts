import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPidfile } from './pidfile'
import { spawnBrokerDetached, stopBrokerDetached } from './spawn'

let home: string
let prevHome: string | undefined
let entry: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-spawn-'))
  prevHome = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
  entry = join(home, 'broker-entry.ts')
  await writeFile(entry, `setInterval(() => {}, 1_000_000_000)\nprocess.on('SIGTERM', () => process.exit(0))\n`)
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('spawnBrokerDetached', () => {
  test('spawns a child process and writes its pidfile', async () => {
    const result = await spawnBrokerDetached({
      cwd: home,
      containerName: 'coder',
      brokerEntry: entry,
    })
    try {
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.alreadyRunning).toBe(false)
      await waitFor(async () => (await readPidfile('coder')) === result.pid)
    } finally {
      await stopBrokerDetached({ containerName: 'coder' })
    }
  })

  test('returns alreadyRunning when a live broker is already registered', async () => {
    const first = await spawnBrokerDetached({
      cwd: home,
      containerName: 'coder',
      brokerEntry: entry,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    try {
      await waitFor(async () => (await readPidfile('coder')) === first.pid)
      const second = await spawnBrokerDetached({
        cwd: home,
        containerName: 'coder',
        brokerEntry: entry,
      })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.alreadyRunning).toBe(true)
      expect(second.pid).toBe(first.pid)
    } finally {
      await stopBrokerDetached({ containerName: 'coder' })
    }
  })

  test('writes broker stdout/stderr to the per-container log file', async () => {
    const noisy = join(home, 'noisy-entry.ts')
    await writeFile(
      noisy,
      `console.log('hello-from-broker')\nsetInterval(() => {}, 1_000_000_000)\nprocess.on('SIGTERM', () => process.exit(0))\n`,
    )

    const result = await spawnBrokerDetached({
      cwd: home,
      containerName: 'coder',
      brokerEntry: noisy,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const logPath = join(home, 'log', 'coder-portbroker.log')
      await waitFor(async () => {
        try {
          const content = await readFile(logPath, 'utf8')
          return content.includes('hello-from-broker')
        } catch {
          return false
        }
      })
    } finally {
      await stopBrokerDetached({ containerName: 'coder' })
    }
  })
})

describe('stopBrokerDetached', () => {
  test('kills the running broker and clears the pidfile', async () => {
    const start = await spawnBrokerDetached({
      cwd: home,
      containerName: 'coder',
      brokerEntry: entry,
    })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    await waitFor(async () => (await readPidfile('coder')) === start.pid)

    const result = await stopBrokerDetached({ containerName: 'coder' })
    expect(result.ok).toBe(true)
    expect(result.killed).toBe(true)
    await waitFor(async () => (await readPidfile('coder')) === null)
  })

  test('is a no-op when no broker is registered', async () => {
    const result = await stopBrokerDetached({ containerName: 'never-started' })
    expect(result.ok).toBe(true)
    expect(result.killed).toBe(false)
  })
})
