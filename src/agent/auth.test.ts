import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'
import { parseSecretsFile } from '@/secrets/schema'

import { getAuth, resetAuthForTesting } from './auth'

describe('getAuth', () => {
  let prevOpenai: string | undefined
  let prevFireworks: string | undefined
  let prevNodeEnv: string | undefined
  let prevCwd: string
  let cwd: string

  beforeEach(async () => {
    prevOpenai = process.env.OPENAI_API_KEY
    prevFireworks = process.env.FIREWORKS_API_KEY
    prevNodeEnv = process.env.NODE_ENV
    delete process.env.OPENAI_API_KEY
    delete process.env.FIREWORKS_API_KEY
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-auth-'))
    // Pin process.cwd() to the tmpdir so the secrets store writes
    // secrets.json under the test scratch dir instead of polluting the repo.
    prevCwd = process.cwd()
    process.chdir(cwd)
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
    process.chdir(prevCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test('persists FIREWORKS_API_KEY to secrets.json on first boot', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_test'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.llm).toEqual({ fireworks: { type: 'api_key', key: 'fw_test' } })
  })

  test('persists OPENAI_API_KEY to secrets.json on first boot', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-test'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.llm).toEqual({ openai: { type: 'api_key', key: 'sk-test' } })
  })

  test('updates secrets.json when the .env key rotated', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({ version: 1, llm: { fireworks: { type: 'api_key', key: 'fw_old' } }, channels: {} }),
    )
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_rotated'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.llm['fireworks']).toEqual({ type: 'api_key', key: 'fw_rotated' })
  })

  test('preserves an existing OAuth credential and ignores the .env key', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    const oauthCredential = {
      type: 'oauth' as const,
      access_token: 'tok',
      refresh_token: 'refresh',
      expires_at: Date.now() + 1_000_000,
    }
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({ version: 1, llm: { openai: oauthCredential }, channels: {} }),
    )
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-from-env'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.llm['openai']).toEqual(oauthCredential)
  })

  test('falls back to a dummy in-memory storage when the provider env var is missing under NODE_ENV=test', async () => {
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

  test('strips the api-key env var from .env after persisting to secrets.json', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(join(cwd, '.env'), 'FIREWORKS_API_KEY=fw_from_env\nUNRELATED=keep-me\n')
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_from_env'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.llm).toEqual({ fireworks: { type: 'api_key', key: 'fw_from_env' } })
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('UNRELATED=keep-me\n')
  })

  test('strips the api-key env var from .env on rotation', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({ version: 1, llm: { fireworks: { type: 'api_key', key: 'fw_old' } }, channels: {} }),
    )
    await writeFile(join(cwd, '.env'), 'FIREWORKS_API_KEY=fw_rotated\n')
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_rotated'

    getAuth()

    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('')
  })

  test('does not touch .env when an OAuth credential already owns the provider slot', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    const oauthCredential = {
      type: 'oauth' as const,
      access_token: 'tok',
      refresh_token: 'refresh',
      expires_at: Date.now() + 1_000_000,
    }
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({ version: 1, llm: { openai: oauthCredential }, channels: {} }),
    )
    const envBefore = 'OPENAI_API_KEY=sk-leave-me\n'
    await writeFile(join(cwd, '.env'), envBefore)
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-leave-me'

    getAuth()

    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(envBefore)
  })

  test('migrates a legacy auth.json to secrets.json on first getAuth()', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    await writeFile(
      join(cwd, 'auth.json'),
      JSON.stringify({
        version: 1,
        llm: { openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } },
        channels: {},
      }),
    )
    reloadConfig(cwd)
    // Force the real-storage branch (the dummy-in-memory path skips
    // createSecretsStoreForAgent and therefore the migration).
    process.env.OPENAI_API_KEY = 'sk-migration-test'

    getAuth()

    await expect(readFile(join(cwd, 'auth.json'), 'utf8')).rejects.toThrow()
    const migrated = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as {
      llm: Record<string, { type: string }>
    }
    expect(migrated.llm.openai?.type).toBe('oauth')
  })
})

async function readSecretsFile(path: string): Promise<{ llm: Record<string, unknown> }> {
  const raw = await readFile(path, 'utf8')
  const result = parseSecretsFile(JSON.parse(raw))
  if (!result.ok) throw new Error(`secrets.json failed to parse: ${result.reason}`)
  return result.file
}
