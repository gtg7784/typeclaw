import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { getAuth, resetAuthForTesting } from './auth'

describe('getAuth', () => {
  let prevOpenai: string | undefined
  let prevFireworks: string | undefined
  let prevNodeEnv: string | undefined
  let cwd: string

  beforeEach(async () => {
    prevOpenai = process.env.OPENAI_API_KEY
    prevFireworks = process.env.FIREWORKS_API_KEY
    prevNodeEnv = process.env.NODE_ENV
    delete process.env.OPENAI_API_KEY
    delete process.env.FIREWORKS_API_KEY
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-auth-'))
    resetAuthForTesting()
  })

  afterEach(async () => {
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenai
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    resetAuthForTesting()
    __resetConfigForTesting()
    await rm(cwd, { recursive: true, force: true })
  })

  test('reads OPENAI_API_KEY when configured model is an OpenAI model', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-test'

    const auth = getAuth()

    expect(auth.authStorage).toBeDefined()
    expect(auth.modelRegistry).toBeDefined()
  })

  test('reads FIREWORKS_API_KEY when configured model is a Fireworks model', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_test'

    const auth = getAuth()

    expect(auth.authStorage).toBeDefined()
    expect(auth.modelRegistry).toBeDefined()
  })

  test('falls back to a dummy key when the provider env var is missing under NODE_ENV=test', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    reloadConfig(cwd)
    process.env.NODE_ENV = 'test'

    const auth = getAuth()

    expect(auth.authStorage).toBeDefined()
    expect(auth.modelRegistry).toBeDefined()
  })

  test('caches the auth object across calls', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-test'

    const a = getAuth()
    const b = getAuth()

    expect(a).toBe(b)
  })
})
