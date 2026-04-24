import { afterEach, describe, expect, test } from 'bun:test'

import type { CronFile, LoadCronResult, Scheduler } from '@/cron'
import type { TuiOptions } from '@/tui'

import { type LoadCronFn, type SchedulerFactory, startAgent, type TuiFactory } from './index'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

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
      return { start: () => {}, stop: () => {} }
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(0)
    expect(running.scheduler).toBeNull()
  })

  test('skips scheduler when cron.json has no jobs', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: true, file: { jobs: [] } }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return { start: () => {}, stop: () => {} }
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(0)
    expect(running.scheduler).toBeNull()
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
    }
    const createSchedulerFor: SchedulerFactory = () => fakeScheduler

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(running.scheduler).toBe(fakeScheduler)
    expect(started).toBe(true)

    running.stop()
    expect(stopped).toBe(true)
  })

  test('logs and continues when cron.json fails to load', async () => {
    const loadCron: LoadCronFn = async () => ({ ok: false, reason: 'bad json' }) as LoadCronResult
    const factoryCalls: Array<{ cwd: string; file: CronFile }> = []
    const createSchedulerFor: SchedulerFactory = (opts) => {
      factoryCalls.push(opts)
      return { start: () => {}, stop: () => {} }
    }

    running = await startAgent({ port: 0, attachTui: false, loadCron, createSchedulerFor })

    expect(factoryCalls).toHaveLength(0)
    expect(running.scheduler).toBeNull()
    expect(running.server.port).toBeGreaterThan(0)
  })
})
