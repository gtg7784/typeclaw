import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'
import { parseSecretsFile } from '@/secrets/schema'

import { getAuth, resetAuthForTesting } from './auth'

describe('getAuth', () => {
  let prevOpenai: string | undefined
  let prevFireworks: string | undefined
  let prevZai: string | undefined
  let prevZaiCoding: string | undefined
  let prevNodeEnv: string | undefined
  let prevCwd: string
  let cwd: string

  beforeEach(async () => {
    prevOpenai = process.env.OPENAI_API_KEY
    prevFireworks = process.env.FIREWORKS_API_KEY
    prevZai = process.env.ZAI_API_KEY
    prevZaiCoding = process.env.ZAI_CODING_API_KEY
    prevNodeEnv = process.env.NODE_ENV
    delete process.env.OPENAI_API_KEY
    delete process.env.FIREWORKS_API_KEY
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-auth-'))
    prevCwd = process.cwd()
    process.chdir(cwd)
    resetAuthForTesting()
  })

  afterEach(async () => {
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenai
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    if (prevZai === undefined) delete process.env.ZAI_API_KEY
    else process.env.ZAI_API_KEY = prevZai
    if (prevZaiCoding === undefined) delete process.env.ZAI_CODING_API_KEY
    else process.env.ZAI_CODING_API_KEY = prevZaiCoding
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    resetAuthForTesting()
    __resetConfigForTesting()
    process.chdir(prevCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test('env-wins: FIREWORKS_API_KEY satisfies hasAuth without persisting to secrets.json', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_test'

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('fireworks')).toBe(true)
    expect(await auth.authStorage.getApiKey('fireworks')).toBe('fw_test')

    if (existsSync(join(cwd, 'secrets.json'))) {
      const file = await readSecretsFile(join(cwd, 'secrets.json'))
      expect(file.providers).toEqual({})
    }
  })

  test('env-wins: ZAI_API_KEY satisfies hasAuth for zai (paygo) without persisting to secrets.json', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'zai/glm-4.6' }))
    reloadConfig(cwd)
    process.env.ZAI_API_KEY = 'zai_test'

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('zai')).toBe(true)
    expect(await auth.authStorage.getApiKey('zai')).toBe('zai_test')
    if (existsSync(join(cwd, 'secrets.json'))) {
      const file = await readSecretsFile(join(cwd, 'secrets.json'))
      expect(file.providers).toEqual({})
    }
  })

  test('env-wins: ZAI_CODING_API_KEY satisfies hasAuth for zai-coding (subscription) and does not bleed into zai', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'zai-coding/glm-5.1' }))
    reloadConfig(cwd)
    process.env.ZAI_CODING_API_KEY = 'zai_coding_test'

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('zai-coding')).toBe(true)
    expect(await auth.authStorage.getApiKey('zai-coding')).toBe('zai_coding_test')
    // The paygo provider must not pick up the coding-plan key: distinct env
    // vars guarantee the two billing surfaces stay isolated.
    expect(auth.authStorage.hasAuth('zai')).toBe(false)
  })

  test('env-wins: OPENAI_API_KEY satisfies hasAuth without persisting to secrets.json', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ model: 'openai/gpt-5.4-nano' }))
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-test'

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('openai')).toBe(true)
    expect(await auth.authStorage.getApiKey('openai')).toBe('sk-test')
    if (existsSync(join(cwd, 'secrets.json'))) {
      const file = await readSecretsFile(join(cwd, 'secrets.json'))
      expect(file.providers).toEqual({})
    }
  })

  test('env wins over file value when both are set', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'fw_disk' } } },
        channels: {},
      }),
    )
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_env'

    const auth = getAuth()

    expect(await auth.authStorage.getApiKey('fireworks')).toBe('fw_env')
  })

  test('file value is used when env var is unset', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'fw_disk' } } },
        channels: {},
      }),
    )
    reloadConfig(cwd)
    // The dummy in-memory branch in getAuth() triggers under NODE_ENV=test
    // when no api-key env var is set. Bypass it so the on-disk file is the
    // credential source under test.
    delete process.env.NODE_ENV

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('fireworks')).toBe(true)
    expect(await auth.authStorage.getApiKey('fireworks')).toBe('fw_disk')
  })

  test('does NOT strip .env after layering env-resolved api-key in-memory', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    const original = 'FIREWORKS_API_KEY=fw_from_env\nUNRELATED=keep-me\n'
    await writeFile(join(cwd, '.env'), original)
    reloadConfig(cwd)
    process.env.FIREWORKS_API_KEY = 'fw_from_env'

    getAuth()

    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(original)
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
      JSON.stringify({ version: 2, providers: { openai: oauthCredential }, channels: {} }),
    )
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-from-env'

    getAuth()

    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    expect(file.providers['openai']).toEqual(oauthCredential)
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
      JSON.stringify({ version: 2, providers: { openai: oauthCredential }, channels: {} }),
    )
    const envBefore = 'OPENAI_API_KEY=sk-leave-me\n'
    await writeFile(join(cwd, '.env'), envBefore)
    reloadConfig(cwd)
    process.env.OPENAI_API_KEY = 'sk-leave-me'

    getAuth()

    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(envBefore)
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

  test('legacy v1 envelope is read on first boot (transparent upgrade)', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' }),
    )
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({ version: 1, llm: { fireworks: { type: 'api_key', key: 'fw_v1' } }, channels: {} }),
    )
    reloadConfig(cwd)
    delete process.env.NODE_ENV

    const auth = getAuth()

    expect(auth.authStorage.hasAuth('fireworks')).toBe(true)
    expect(await auth.authStorage.getApiKey('fireworks')).toBe('fw_v1')
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
    process.env.OPENAI_API_KEY = 'sk-migration-test'

    getAuth()

    await expect(readFile(join(cwd, 'auth.json'), 'utf8')).rejects.toThrow()
    const file = await readSecretsFile(join(cwd, 'secrets.json'))
    const openai = file.providers['openai']
    expect(openai).toBeDefined()
    expect((openai as { type: string }).type).toBe('oauth')
  })
})

async function readSecretsFile(path: string): Promise<{ providers: Record<string, unknown> }> {
  const raw = await readFile(path, 'utf8')
  const result = parseSecretsFile(JSON.parse(raw))
  if (!result.ok) throw new Error(`secrets.json failed to parse: ${result.reason}`)
  return result.file
}
