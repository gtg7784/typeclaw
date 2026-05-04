import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getAuth, resetAuthForTesting } from './auth'

describe('getAuth', () => {
  let prevKey: string | undefined
  let prevNodeEnv: string | undefined

  beforeEach(() => {
    prevKey = process.env.FIREWORKS_API_KEY
    prevNodeEnv = process.env.NODE_ENV
    resetAuthForTesting()
  })

  afterEach(() => {
    if (prevKey === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevKey
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    resetAuthForTesting()
  })

  test('returns auth object when FIREWORKS_API_KEY is set', () => {
    process.env.FIREWORKS_API_KEY = 'fw_test_key'
    const auth = getAuth()
    expect(auth.authStorage).toBeDefined()
    expect(auth.modelRegistry).toBeDefined()
  })

  test('falls back to a dummy key when FIREWORKS_API_KEY is missing under NODE_ENV=test', () => {
    delete process.env.FIREWORKS_API_KEY
    process.env.NODE_ENV = 'test'
    const auth = getAuth()
    expect(auth.authStorage).toBeDefined()
    expect(auth.modelRegistry).toBeDefined()
  })

  test('caches the auth object across calls', () => {
    process.env.FIREWORKS_API_KEY = 'fw_test_key'
    const a = getAuth()
    const b = getAuth()
    expect(a).toBe(b)
  })
})
