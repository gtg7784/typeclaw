import { describe, expect, test } from 'bun:test'

import { createKeyedSemaphore, SemaphoreAbortedError } from './keyed-semaphore'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createKeyedSemaphore', () => {
  test('caps concurrent runs per key at the configured limit', async () => {
    // given
    const sem = createKeyedSemaphore({ concurrency: 2 })
    let active = 0
    let peak = 0
    const gate = deferred()

    const work = async () => {
      active++
      peak = Math.max(peak, active)
      await gate.promise
      active--
    }

    // when: launch 4 against the same key, then release
    const runs = [sem.run('k', work), sem.run('k', work), sem.run('k', work), sem.run('k', work)]
    await Promise.resolve()
    await Promise.resolve()
    gate.resolve()
    await Promise.all(runs)

    // then
    expect(peak).toBe(2)
  })

  test('queued work waits and runs after a slot frees (never skipped)', async () => {
    // given
    const sem = createKeyedSemaphore({ concurrency: 1 })
    const order: string[] = []
    const first = deferred()

    // when
    const a = sem.run('k', async () => {
      order.push('a-start')
      await first.promise
      order.push('a-end')
    })
    const b = sem.run('k', async () => {
      order.push('b-start')
    })

    await Promise.resolve()
    expect(order).toEqual(['a-start'])
    first.resolve()
    await Promise.all([a, b])

    // then: b ran only after a released, and was not dropped
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
  })

  test('distinct keys never contend', async () => {
    // given
    const sem = createKeyedSemaphore({ concurrency: 1 })
    let active = 0
    let peak = 0
    const gate = deferred()
    const work = async () => {
      active++
      peak = Math.max(peak, active)
      await gate.promise
      active--
    }

    // when: two different keys run together
    const runs = [sem.run('a', work), sem.run('b', work)]
    await Promise.resolve()
    gate.resolve()
    await Promise.all(runs)

    // then
    expect(peak).toBe(2)
  })

  test('releases the slot even when work throws', async () => {
    // given
    const sem = createKeyedSemaphore({ concurrency: 1 })

    // when
    await expect(sem.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    const after = await sem.run('k', async () => 'ok')

    // then: the rejected run did not leak the slot
    expect(after).toBe('ok')
  })

  test('rejects immediately without running work when the signal is already aborted', async () => {
    // given
    const sem = createKeyedSemaphore({ concurrency: 1 })
    let ran = false
    const controller = new AbortController()
    controller.abort()

    // when / then
    await expect(
      sem.run(
        'k',
        async () => {
          ran = true
          return 'ok'
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(SemaphoreAbortedError)
    expect(ran).toBe(false)
  })

  test('a queued call that aborts before admission rejects without running work', async () => {
    // given: the only slot is held open
    const sem = createKeyedSemaphore({ concurrency: 1 })
    const hold = deferred()
    const occupier = sem.run('k', async () => {
      await hold.promise
    })

    // when: a second call queues, then aborts before the slot frees
    let queuedRan = false
    const controller = new AbortController()
    const queued = sem.run(
      'k',
      async () => {
        queuedRan = true
      },
      controller.signal,
    )
    await Promise.resolve()
    controller.abort()

    // then: the queued call rejected and never ran
    await expect(queued).rejects.toBeInstanceOf(SemaphoreAbortedError)
    expect(queuedRan).toBe(false)

    // and: the freed slot is still usable by a fresh caller after the occupier releases
    hold.resolve()
    await occupier
    const after = await sem.run('k', async () => 'ok')
    expect(after).toBe('ok')
  })

  test('an aborted queued waiter does not consume the slot handed to it', async () => {
    // given: concurrency 1, slot held, two queued waiters (one will abort)
    const sem = createKeyedSemaphore({ concurrency: 1 })
    const hold = deferred()
    const occupier = sem.run('k', async () => {
      await hold.promise
    })

    const controller = new AbortController()
    const abortedQueued = sem.run('k', async () => 'should-not-run', controller.signal)
    const secondGate = deferred()
    let secondRan = false
    const secondQueued = sem.run('k', async () => {
      secondRan = true
      await secondGate.promise
    })

    // when: first queued aborts, then the occupier releases its slot
    await Promise.resolve()
    controller.abort()
    await expect(abortedQueued).rejects.toBeInstanceOf(SemaphoreAbortedError)
    hold.resolve()
    await occupier
    await Promise.resolve()

    // then: the slot was handed to the live waiter, not lost to the aborted one
    expect(secondRan).toBe(true)
    secondGate.resolve()
    await secondQueued
  })
})
