import { afterEach, describe, expect, test } from 'bun:test'

import type { TuiOptions } from '@/tui'

import { startAgent, type TuiFactory } from './index'

let running: ReturnType<typeof startAgent> | null = null

afterEach(async () => {
  if (!running) return
  running.server.stop(true)
  // tuiPromise intentionally not awaited - the real tui resolves when the
  // server closes its socket, and test fakes may return pending promises.
  running.tuiPromise?.catch(() => {})
  running = null
})

describe('startAgent', () => {
  test('starts a ws server on an ephemeral port in headless mode', async () => {
    // given
    running = startAgent({ port: 0, attachTui: false })

    // then
    expect(running.server.port).toBeGreaterThan(0)
    expect(running.tuiPromise).toBeNull()

    const res = await fetch(`http://localhost:${running.server.port}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('typeclaw agent')
  })

  test('attaches a local tui pointing at the server it just started', () => {
    // given
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => new Promise<void>(() => {}) }
    }

    // when
    running = startAgent({
      port: 0,
      attachTui: true,
      initialPrompt: 'hello',
      createTui: fakeTui,
    })

    // then
    expect(running.tuiPromise).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`ws://localhost:${running.server.port}`)
    expect(calls[0]?.initialPrompt).toBe('hello')
  })

  test('does not instantiate a tui when attachTui is false', () => {
    // given
    const calls: TuiOptions[] = []
    const fakeTui: TuiFactory = (opts) => {
      calls.push(opts)
      return { run: () => Promise.resolve() }
    }

    // when
    running = startAgent({ port: 0, attachTui: false, createTui: fakeTui })

    // then
    expect(calls).toHaveLength(0)
    expect(running.tuiPromise).toBeNull()
  })

  test('stop() shuts the ws server down so the port stops accepting connections', async () => {
    // given
    running = startAgent({ port: 0, attachTui: false })
    const port = running.server.port
    const before = await fetch(`http://localhost:${port}`)
    expect(before.status).toBe(200)

    // when
    running.stop()

    // then
    await expect(fetch(`http://localhost:${port}`)).rejects.toThrow()
  })
})
