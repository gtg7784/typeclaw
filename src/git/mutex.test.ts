import { describe, expect, test } from 'bun:test'

import { withGitLock } from './mutex'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = async (): Promise<void> => {
  await Promise.resolve()
}

describe('withGitLock', () => {
  test('serializes calls with the same key', async () => {
    const order: string[] = []
    const firstCanFinish = deferred()
    const secondStarted = deferred()

    const first = withGitLock('agent-a', async () => {
      order.push('first:start')
      await firstCanFinish.promise
      order.push('first:end')
    })
    const second = withGitLock('agent-a', async () => {
      order.push('second:start')
      secondStarted.resolve()
    })

    await tick()
    expect(order).toEqual(['first:start'])
    firstCanFinish.resolve()
    await secondStarted.promise
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  test('runs distinct keys concurrently', async () => {
    const order: string[] = []
    const firstCanFinish = deferred()
    const secondStarted = deferred()

    const first = withGitLock('agent-a', async () => {
      order.push('first:start')
      await firstCanFinish.promise
      order.push('first:end')
    })
    const second = withGitLock('agent-b', async () => {
      order.push('second:start')
      secondStarted.resolve()
    })

    await secondStarted.promise
    expect(order).toEqual(['first:start', 'second:start'])
    firstCanFinish.resolve()
    await Promise.all([first, second])
  })

  test('releases the lock after a callback throws', async () => {
    const order: string[] = []
    const first = withGitLock('agent-a', async () => {
      order.push('first:start')
      throw new Error('boom')
    })
    const second = withGitLock('agent-a', async () => {
      order.push('second:start')
    })

    await expect(first).rejects.toThrow('boom')
    await second
    expect(order).toEqual(['first:start', 'second:start'])
  })

  test('propagates the callback return value', async () => {
    await expect(withGitLock('agent-a', async () => 42)).resolves.toBe(42)
  })
})
