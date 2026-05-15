import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scaffold, writeSecrets } from '@/init'

import {
  addProfile,
  isKnownModelRef,
  listAvailableModelRefs,
  listModelProfiles,
  removeProfile,
  setProfile,
} from './models-mutation'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-models-mutation-'))
  await scaffold(root, { model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
  await writeSecrets(root, {
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    apiKey: 'fw_initial',
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readModels(): Promise<Record<string, string>> {
  const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
  const parsed = JSON.parse(raw) as { models?: Record<string, string> }
  return parsed.models ?? {}
}

describe('listAvailableModelRefs', () => {
  test('returns all KNOWN_PROVIDERS model refs', () => {
    const refs = listAvailableModelRefs()
    expect(refs).toContain('openai/gpt-5.4-nano')
    expect(refs).toContain('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(refs.length).toBeGreaterThan(5)
  })
})

describe('isKnownModelRef', () => {
  test('accepts canonical refs', () => {
    expect(isKnownModelRef('openai/gpt-5.4-nano')).toBe(true)
  })

  test('rejects unknown refs', () => {
    expect(isKnownModelRef('mystery/model')).toBe(false)
    expect(isKnownModelRef('')).toBe(false)
    expect(isKnownModelRef('fireworks')).toBe(false)
  })
})

describe('setProfile', () => {
  test('updates the default profile when credentials are present', async () => {
    const result = setProfile(root, 'default', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).default).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })

  test('creates a new profile beside default', async () => {
    setProfile(root, 'default', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const result = setProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).fast).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })

  test('refuses unknown model refs', () => {
    const result = setProfile(root, 'default', 'mystery/model')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Unknown model')
  })

  test('refuses empty profile names', () => {
    const result = setProfile(root, '   ', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Profile name')
  })

  test('refuses when target provider has no credentials', () => {
    const env: NodeJS.ProcessEnv = {}
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('has no credentials')
    expect(result.reason).toContain('typeclaw provider add openai')
    expect(result.reason).toContain('--force')
  })

  test('proceeds when target provider credentials come from env', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-from-env' }
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env })
    expect(result.ok).toBe(true)
  })

  test('force=true writes even without credentials', () => {
    const env: NodeJS.ProcessEnv = {}
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env, force: true })
    expect(result.ok).toBe(true)
  })
})

describe('addProfile', () => {
  test('refuses to overwrite an existing profile', () => {
    const result = addProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already exists')
    expect(result.reason).toContain('typeclaw model set')
  })

  test('creates a fresh profile', async () => {
    const result = addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).fast).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })
})

describe('removeProfile', () => {
  test('refuses to remove the default profile', () => {
    const result = removeProfile(root, 'default')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Cannot remove')
    expect(result.reason).toContain('model set default')
  })

  test('removes a non-default profile', async () => {
    addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const result = removeProfile(root, 'fast')
    expect(result.ok).toBe(true)
    const models = await readModels()
    expect(models).not.toHaveProperty('fast')
    expect(models.default).toBeDefined()
  })

  test('errors when profile does not exist', () => {
    const result = removeProfile(root, 'nonexistent')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not found')
  })
})

describe('listModelProfiles', () => {
  test('lists default first, then alphabetical', () => {
    addProfile(root, 'zeta', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    addProfile(root, 'alpha', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const entries = listModelProfiles(root)
    expect(entries.map((e) => e.profile)).toEqual(['default', 'alpha', 'zeta'])
    expect(entries[0]?.isDefault).toBe(true)
    expect(entries[1]?.isDefault).toBe(false)
  })

  test('marks profiles with missing credentials', () => {
    addProfile(root, 'vision', 'openai/gpt-5.4-mini', { force: true })
    const env: NodeJS.ProcessEnv = {}
    const entries = listModelProfiles(root, env)
    const vision = entries.find((e) => e.profile === 'vision')
    expect(vision?.credentialStatus).toBe('missing-credentials')
    const dflt = entries.find((e) => e.profile === 'default')
    expect(dflt?.credentialStatus).toBe('available')
  })

  test('credentialStatus uses env override when set', () => {
    addProfile(root, 'vision', 'openai/gpt-5.4-mini', { force: true })
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-x' }
    const entries = listModelProfiles(root, env)
    const vision = entries.find((e) => e.profile === 'vision')
    expect(vision?.credentialStatus).toBe('available')
  })
})
