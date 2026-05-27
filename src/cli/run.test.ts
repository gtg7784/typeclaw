import { describe, expect, test } from 'bun:test'

import { shutdown } from './run'

describe('shutdown', () => {
  test('awaits stop() before invoking exit', async () => {
    // given: a stop() that resolves after a microtask hop
    const events: string[] = []
    const stop = async (): Promise<void> => {
      await Promise.resolve()
      events.push('stop:resolved')
    }
    const exit = (code: number): void => {
      events.push(`exit:${code}`)
    }

    // when
    await shutdown({ stop, exit })

    // then
    expect(events).toEqual(['stop:resolved', 'exit:0'])
  })

  test('exits with 1 if stop() throws so async teardown failures surface in container exit code', async () => {
    // given
    const events: string[] = []
    const stop = async (): Promise<void> => {
      await Promise.resolve()
      throw new Error('boom')
    }
    const exit = (code: number): void => {
      events.push(`exit:${code}`)
    }

    // when
    await shutdown({ stop, exit })

    // then
    expect(events).toEqual(['exit:1'])
  })

  test('does not invoke exit until every awaited side-effect in stop() completes', async () => {
    // given: a stop() that performs multiple async hops, mimicking the real
    // channelManager.stop() → adapter.stop() → deregisterGithubWebhooks() chain
    const events: string[] = []
    const stop = async (): Promise<void> => {
      await Promise.resolve()
      events.push('a')
      await Promise.resolve()
      events.push('b')
      await Promise.resolve()
      events.push('c')
    }
    const exit = (code: number): void => {
      events.push(`exit:${code}`)
    }

    // when
    await shutdown({ stop, exit })

    // then
    expect(events).toEqual(['a', 'b', 'c', 'exit:0'])
  })
})
