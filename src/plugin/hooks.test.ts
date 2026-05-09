import { describe, expect, test } from 'bun:test'

import { createHookBus } from './hooks'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('HookBus session.prompt', () => {
  test('multiple plugins compose; each sees the previous mutation', async () => {
    const bus = createHookBus()
    bus.registerAll('p1', '/agent', noopLogger, {
      'session.prompt': (event) => {
        event.prompt += '\n[from p1]'
      },
    })
    bus.registerAll('p2', '/agent', noopLogger, {
      'session.prompt': (event) => {
        event.prompt += '\n[from p2]'
      },
    })

    const event = { prompt: 'BASE', sessionId: 's', agentDir: '/agent' }
    await bus.runSessionPrompt(event)

    expect(event.prompt).toBe('BASE\n[from p1]\n[from p2]')
  })

  test('plugin-throwing handler does not break later plugins', async () => {
    const bus = createHookBus()
    bus.registerAll('p1', '/agent', noopLogger, {
      'session.prompt': () => {
        throw new Error('boom')
      },
    })
    bus.registerAll('p2', '/agent', noopLogger, {
      'session.prompt': (event) => {
        event.prompt += '\n[ok]'
      },
    })
    const event = { prompt: 'BASE', sessionId: 's', agentDir: '/agent' }
    await bus.runSessionPrompt(event)
    expect(event.prompt).toBe('BASE\n[ok]')
  })
})

describe('HookBus tool.before', () => {
  test('mutations to event.args compose; first { block } short-circuits', async () => {
    const bus = createHookBus()
    const seen: Record<string, unknown>[] = []
    bus.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        seen.push({ ...event.args })
        event.args.via = 'p1'
      },
    })
    bus.registerAll('p2', '/agent', noopLogger, {
      'tool.before': (event) => {
        seen.push({ ...event.args })
        return { block: true, reason: 'denied' }
      },
    })
    bus.registerAll('p3', '/agent', noopLogger, {
      'tool.before': (event) => {
        seen.push({ ...event.args })
      },
    })

    const result = await bus.runToolBefore({
      tool: 't',
      sessionId: 's',
      callId: 'c1',
      args: { foo: 1 },
    })
    expect(result).toEqual({ block: true, reason: 'denied' })
    expect(seen).toEqual([{ foo: 1 }, { foo: 1, via: 'p1' }])
  })

  test('returns undefined when no plugin blocks', async () => {
    const bus = createHookBus()
    bus.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => {},
    })
    const result = await bus.runToolBefore({ tool: 't', sessionId: 's', callId: 'c', args: {} })
    expect(result).toBeUndefined()
  })
})

describe('HookBus session.idle / session.start / session.end', () => {
  test('observe-only hooks fire in registration order with the event payload', async () => {
    const bus = createHookBus()
    const calls: string[] = []
    bus.registerAll('p1', '/agent', noopLogger, {
      'session.idle': (event) => {
        calls.push(`p1:${event.sessionId}:${event.idleMs}`)
      },
      'session.start': (event) => {
        calls.push(`p1:start:${event.sessionId}`)
      },
      'session.end': (event) => {
        calls.push(`p1:end:${event.sessionId}`)
      },
    })
    bus.registerAll('p2', '/agent', noopLogger, {
      'session.idle': (event) => {
        calls.push(`p2:${event.sessionId}`)
      },
    })

    await bus.runSessionStart({ sessionId: 's1', agentDir: '/agent' })
    await bus.runSessionIdle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 1000 })
    await bus.runSessionEnd({ sessionId: 's1' })

    expect(calls).toEqual(['p1:start:s1', 'p1:s1:1000', 'p2:s1', 'p1:end:s1'])
  })
})

describe('HookBus session.idle per-handler timeout', () => {
  test('a hung handler is bounded; the offending plugin is named; later handlers still run', async () => {
    // given a bus where the first session.idle handler never resolves and
    // the second is observable. the per-handler timeout is a test seam so
    // the timeout fires in milliseconds instead of the production 25s.
    const errors: { plugin: string; message: string }[] = []
    const recordLogger = (pluginName: string) => ({
      info: () => {},
      warn: () => {},
      error: (m: string) => errors.push({ plugin: pluginName, message: m }),
    })
    const bus = createHookBus({ idleHandlerTimeoutMs: 30 })
    bus.registerAll('hung-plugin', '/agent', recordLogger('hung-plugin'), {
      'session.idle': () => new Promise(() => {}),
    })
    let secondRan = false
    bus.registerAll('healthy-plugin', '/agent', recordLogger('healthy-plugin'), {
      'session.idle': () => {
        secondRan = true
      },
    })

    // when the chain runs
    const start = Date.now()
    await bus.runSessionIdle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 })
    const elapsed = Date.now() - start

    // then the chain returned within the per-handler ceiling, the offending
    // plugin's logger received the timeout error with attribution, and the
    // healthy plugin still got to run
    expect(elapsed).toBeLessThan(500)
    expect(secondRan).toBe(true)
    const hungError = errors.find((e) => e.plugin === 'hung-plugin')
    expect(hungError?.message).toMatch(/plugin hung-plugin session\.idle timed out after 30ms/)
    // the healthy plugin must not have been blamed
    expect(errors.find((e) => e.plugin === 'healthy-plugin')).toBeUndefined()
  })
})

describe('HookBus session.end per-handler timeout', () => {
  test('a hung handler is bounded; the offending plugin is named; later handlers still run', async () => {
    // given a bus where the first session.end handler never resolves and
    // the second is observable. without this timeout, cron consumer's
    // runPrompt finally block awaits runSessionEnd forever, leaving inFlight
    // permanently populated and silently coalescing every future cron fire.
    const errors: { plugin: string; message: string }[] = []
    const recordLogger = (pluginName: string) => ({
      info: () => {},
      warn: () => {},
      error: (m: string) => errors.push({ plugin: pluginName, message: m }),
    })
    const bus = createHookBus({ endHandlerTimeoutMs: 30 })
    bus.registerAll('hung-plugin', '/agent', recordLogger('hung-plugin'), {
      'session.end': () => new Promise(() => {}),
    })
    let secondRan = false
    bus.registerAll('healthy-plugin', '/agent', recordLogger('healthy-plugin'), {
      'session.end': () => {
        secondRan = true
      },
    })

    // when the chain runs
    const start = Date.now()
    await bus.runSessionEnd({ sessionId: 's1' })
    const elapsed = Date.now() - start

    // then the chain returned within the per-handler ceiling, the offending
    // plugin's logger received the timeout error with attribution, and the
    // healthy plugin still got to run
    expect(elapsed).toBeLessThan(500)
    expect(secondRan).toBe(true)
    const hungError = errors.find((e) => e.plugin === 'hung-plugin')
    expect(hungError?.message).toMatch(/plugin hung-plugin session\.end timed out after 30ms/)
    expect(errors.find((e) => e.plugin === 'healthy-plugin')).toBeUndefined()
  })
})

describe('HookBus unregisterAll', () => {
  test('removes hooks for a single plugin and leaves others intact', () => {
    const bus = createHookBus()
    bus.registerAll('p1', '/agent', noopLogger, { 'session.start': () => {}, 'tool.before': () => {} })
    bus.registerAll('p2', '/agent', noopLogger, { 'session.start': () => {} })
    expect(bus.count('session.start')).toBe(2)
    expect(bus.count('tool.before')).toBe(1)

    bus.unregisterAll('p1')

    expect(bus.count('session.start')).toBe(1)
    expect(bus.count('tool.before')).toBe(0)
  })
})
