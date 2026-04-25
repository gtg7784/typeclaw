import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CronFile, CronJob, LoadCronResult, Scheduler } from '@/cron'
import type { SessionFactory } from '@/sessions'
import type { TuiOptions } from '@/tui'

import { type LoadCronFn, type SchedulerFactory, startAgent, type TuiFactory } from './index'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

function stubScheduler(): Scheduler {
  return {
    start: () => {},
    stop: () => {},
    replaceJobs: () => ({ added: [], removed: [], updated: [], unchanged: [] }),
  }
}

let running: Awaited<ReturnType<typeof startAgent>> | null = null

afterEach(async () => {
  if (!running) return
  running.server.stop(true)
  running.tuiPromise?.catch(() => {})
  running = null
})

describe('startAgent', () => {
  test('starts a ws server on an ephemeral port in headless mode', async () => {
    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron })

    expect(running.server.port).toBeGreaterThan(0)
    expect(running.tuiPromise).toBeNull()

    const res = await fetch(`http://localhost:${running.server.port}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('typeclaw agent')
  })

  test('attaches a local tui pointing at the server it just started', async () => {
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => new Promise<void>(() => {}) }
    }

    running = await startAgent({
      port: 0,
      attachTui: true,
      initialPrompt: 'hello',
      createTui: fakeTui,
      loadCron: noCron,
    })

    expect(running.tuiPromise).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`ws://localhost:${running.server.port}`)
    expect(calls[0]?.initialPrompt).toBe('hello')
  })

  test('does not instantiate a tui when attachTui is false', async () => {
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => Promise.resolve() }
    }

    running = await startAgent({ port: 0, attachTui: false, createTui: fakeTui, loadCron: noCron })

    expect(calls).toHaveLength(0)
    expect(running.tuiPromise).toBeNull()
  })

  test('stop() shuts the ws server down so the port stops accepting connections', async () => {
    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron })
    const port = running.server.port
    const before = await fetch(`http://localhost:${port}`)
    expect(before.status).toBe(200)

    running.stop()

    await expect(fetch(`http://localhost:${port}`)).rejects.toThrow()
  })

  test('skips scheduler when cron.json is absent', async () => {
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(0)
    expect(running.scheduler).toBeNull()
  })

  test('creates scheduler when cron.json exists but has no jobs (so reload can later swap in jobs)', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(1)
    expect(running.scheduler).not.toBeNull()
  })

  test('starts scheduler when cron.json has jobs', async () => {
    const file: CronFile = {
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }],
    }
    const loadCron: LoadCronFn = async () => ({ ok: true, file }) as LoadCronResult
    let started = false
    let stopped = false
    const fakeScheduler: Scheduler = {
      start: () => {
        started = true
      },
      stop: () => {
        stopped = true
      },
      replaceJobs: () => ({ added: [], removed: [], updated: [], unchanged: [] }),
    }
    const createSchedulerFor: SchedulerFactory = () => fakeScheduler

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(running.scheduler).toBe(fakeScheduler)
    expect(started).toBe(true)

    running.stop()
    expect(stopped).toBe(true)
  })

  test('registers cron in the reload registry when scheduler is created', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const createSchedulerFor: SchedulerFactory = () => stubScheduler()

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(running.reloadRegistry.has('cron')).toBe(true)
  })

  test('does not register cron in the reload registry when cron.json is absent', async () => {
    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron })

    expect(running.reloadRegistry.has('cron')).toBe(false)
  })

  test('logs and continues when cron.json fails to load', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: false, reason: 'bad json' }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(0)
    expect(running.scheduler).toBeNull()
    expect(running.server.port).toBeGreaterThan(0)
  })

  test('passes onFire to the scheduler factory; firing publishes a kind:cron message to the stream', async () => {
    // given
    const file: CronFile = {
      jobs: [{ id: 'job-x', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }],
    }
    const loadCron: LoadCronFn = async () => ({ ok: true, file }) as LoadCronResult
    let captured: ((job: CronJob) => void) | null = null
    const createSchedulerFor: SchedulerFactory = ({ onFire }) => {
      captured = onFire
      return stubScheduler()
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    const cronMessages: unknown[] = []
    running.stream.subscribe({ target: { kind: 'cron' } }, (msg) => {
      cronMessages.push(msg.payload)
    })

    // when
    expect(captured).not.toBeNull()
    captured!(file.jobs[0]!)

    // then
    expect(cronMessages).toHaveLength(1)
    expect(cronMessages[0]).toEqual(file.jobs[0]!)
  })

  test('cronConsumer is started when scheduler is created and stopped on stop()', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const createSchedulerFor: SchedulerFactory = () => stubScheduler()

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(running.cronConsumer).not.toBeNull()
  })

  test('cronConsumer is null when scheduler is null (no cron.json)', async () => {
    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron })

    expect(running.cronConsumer).toBeNull()
  })
})

describe('startAgent session persistence wiring', () => {
  let agentDir: string

  afterEach(async () => {
    if (agentDir) await rm(agentDir, { recursive: true, force: true })
  })

  test('creates <cwd>/sessions/ on disk when no sessionFactory is injected', async () => {
    // given
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-'))

    // when
    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    // then
    expect(existsSync(join(agentDir, 'sessions'))).toBe(true)
  })

  test('uses an injected sessionFactory instead of constructing the default one', async () => {
    // given
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-run-'))
    const stubDir = join(agentDir, 'custom-sessions')
    let dirCalls = 0
    let createCalls = 0
    const stubFactory: SessionFactory = {
      sessionDir: () => {
        dirCalls++
        return stubDir
      },
      createPersisted: () => {
        createCalls++
        throw new Error('createPersisted should not be called without an active ws connection')
      },
    }

    // when
    running = await startAgent({
      port: 0,
      attachTui: false,
      cwd: agentDir,
      loadCron: noCron,
      sessionFactory: stubFactory,
    })

    // then
    expect(existsSync(join(agentDir, 'sessions'))).toBe(false)
    expect(dirCalls + createCalls).toBe(0)
  })
})
