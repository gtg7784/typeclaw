import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initStateDir } from '@/hostd'

import {
  checkpointFromSelections,
  createHostWizardCheckpointStore,
  sanitizeCheckpointAgainstCatalog,
  WIZARD_CHECKPOINT_VERSION,
  type WizardAnswerCheckpointV1,
} from './checkpoint'

const KIMI_REF = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' as WizardAnswerCheckpointV1['modelRef']

let home: string
let prev: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-checkpoint-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
})

afterEach(async () => {
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

describe('checkpointFromSelections', () => {
  test('projects only the supplied non-secret selections', () => {
    const checkpoint = checkpointFromSelections({
      cwd: '/agent',
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: KIMI_REF,
      authMethod: 'api-key',
      channelChoice: 'slack',
    })

    expect(checkpoint.version).toBe(WIZARD_CHECKPOINT_VERSION)
    expect(checkpoint.cwd).toBe('/agent')
    expect(checkpoint.vendorId).toBe('fireworks')
    expect(checkpoint.modelRef).toBe(KIMI_REF)
    expect(checkpoint.channelChoice).toBe('slack')
    expect(typeof checkpoint.updatedAt).toBe('string')
  })

  test('never carries fields that were not supplied', () => {
    const checkpoint = checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' })
    expect('providerId' in checkpoint).toBe(false)
    expect('modelRef' in checkpoint).toBe(false)
    expect('channelChoice' in checkpoint).toBe(false)
  })

  test('serialized form contains no secret-shaped keys', () => {
    const checkpoint = checkpointFromSelections({
      cwd: '/agent',
      providerId: 'fireworks',
      modelRef: KIMI_REF,
      authMethod: 'oauth',
    })
    const serialized = JSON.stringify(checkpoint)
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('llmAuth')
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('token')
  })
})

describe('createHostWizardCheckpointStore', () => {
  test('save then load round-trips the checkpoint', async () => {
    const store = createHostWizardCheckpointStore()
    const checkpoint = checkpointFromSelections({
      cwd: '/agent/one',
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: KIMI_REF,
      channelChoice: 'discord',
    })

    await store.save('/agent/one', checkpoint)
    const loaded = await store.load('/agent/one')

    expect(loaded).toEqual(checkpoint)
  })

  test('load returns undefined when no checkpoint exists', async () => {
    const store = createHostWizardCheckpointStore()
    expect(await store.load('/agent/missing')).toBeUndefined()
  })

  test('distinct cwds get distinct checkpoint files', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/a', checkpointFromSelections({ cwd: '/agent/a', vendorId: 'fireworks' }))
    await store.save('/agent/b', checkpointFromSelections({ cwd: '/agent/b', vendorId: 'openai' }))

    expect((await store.load('/agent/a'))?.vendorId).toBe('fireworks')
    expect((await store.load('/agent/b'))?.vendorId).toBe('openai')
  })

  test('clear removes the checkpoint file', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    await store.clear('/agent/one')
    expect(await store.load('/agent/one')).toBeUndefined()
  })

  test('clear on a missing checkpoint is a no-op', async () => {
    const store = createHostWizardCheckpointStore()
    await store.clear('/agent/never-saved')
    expect(await store.load('/agent/never-saved')).toBeUndefined()
  })

  test('save leaves no .tmp residue', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(initStateDir())
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
    expect(entries.length).toBe(1)
  })

  test('load tolerates a corrupt (non-JSON) file', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    const { readdir } = await import('node:fs/promises')
    const [file] = await readdir(initStateDir())
    await writeFile(join(initStateDir(), file!), 'not json {{{')
    expect(await store.load('/agent/one')).toBeUndefined()
  })

  test('load rejects a checkpoint with the wrong schema version', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    const { readdir } = await import('node:fs/promises')
    const [file] = await readdir(initStateDir())
    const path = join(initStateDir(), file!)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...parsed, version: 999 }))
    expect(await store.load('/agent/one')).toBeUndefined()
  })

  test('save creates initStateDir on demand', async () => {
    const store = createHostWizardCheckpointStore()
    expect(existsSync(initStateDir())).toBe(false)
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    expect(existsSync(initStateDir())).toBe(true)
  })

  test('rejects a checkpoint whose optional field has a non-string type', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/one', checkpointFromSelections({ cwd: '/agent/one', vendorId: 'fireworks' }))
    const { readdir } = await import('node:fs/promises')
    const [file] = await readdir(initStateDir())
    const path = join(initStateDir(), file!)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    // given: a structurally corrupt providerId (number instead of string)
    await writeFile(path, JSON.stringify({ ...parsed, providerId: 42 }))
    expect(await store.load('/agent/one')).toBeUndefined()
  })

  test('accepts a checkpoint whose optional fields are absent', async () => {
    const store = createHostWizardCheckpointStore()
    await store.save('/agent/two', checkpointFromSelections({ cwd: '/agent/two' }))
    const loaded = await store.load('/agent/two')
    expect(loaded?.cwd).toBe('/agent/two')
  })
})

describe('sanitizeCheckpointAgainstCatalog', () => {
  const validModelRefs = new Set<WizardAnswerCheckpointV1['modelRef']>([KIMI_REF])

  test('keeps valid vendor/provider/model/channel', () => {
    const input: WizardAnswerCheckpointV1 = {
      version: WIZARD_CHECKPOINT_VERSION,
      cwd: '/agent',
      updatedAt: 'now',
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: KIMI_REF,
      authMethod: 'api-key',
      channelChoice: 'slack',
    }
    const out = sanitizeCheckpointAgainstCatalog(input, validModelRefs as Set<never>)
    expect(out.vendorId).toBe('fireworks')
    expect(out.providerId).toBe('fireworks')
    expect(out.modelRef).toBe(KIMI_REF)
    expect(out.authMethod).toBe('api-key')
    expect(out.channelChoice).toBe('slack')
  })

  test('drops a stale model ref but keeps provider and auth', () => {
    const input: WizardAnswerCheckpointV1 = {
      version: WIZARD_CHECKPOINT_VERSION,
      cwd: '/agent',
      updatedAt: 'now',
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: 'fireworks/deleted-model' as WizardAnswerCheckpointV1['modelRef'],
      authMethod: 'api-key',
    }
    const out = sanitizeCheckpointAgainstCatalog(input, validModelRefs as Set<never>)
    expect(out.providerId).toBe('fireworks')
    expect(out.authMethod).toBe('api-key')
    expect(out.modelRef).toBeUndefined()
  })

  test('an unknown vendor cascades: drops provider, model, and auth', () => {
    const input: WizardAnswerCheckpointV1 = {
      version: WIZARD_CHECKPOINT_VERSION,
      cwd: '/agent',
      updatedAt: 'now',
      vendorId: 'made-up-vendor' as WizardAnswerCheckpointV1['vendorId'],
      providerId: 'fireworks',
      modelRef: KIMI_REF,
      authMethod: 'api-key',
      channelChoice: 'slack',
    }
    const out = sanitizeCheckpointAgainstCatalog(input, validModelRefs as Set<never>)
    expect(out.vendorId).toBeUndefined()
    expect(out.providerId).toBeUndefined()
    expect(out.modelRef).toBeUndefined()
    expect(out.authMethod).toBeUndefined()
    // Channel choice is independent of the provider cascade.
    expect(out.channelChoice).toBe('slack')
  })

  test('a provider not belonging to its vendor is dropped', () => {
    const input: WizardAnswerCheckpointV1 = {
      version: WIZARD_CHECKPOINT_VERSION,
      cwd: '/agent',
      updatedAt: 'now',
      vendorId: 'fireworks',
      providerId: 'openai',
      modelRef: KIMI_REF,
    }
    const out = sanitizeCheckpointAgainstCatalog(input, validModelRefs as Set<never>)
    expect(out.vendorId).toBe('fireworks')
    expect(out.providerId).toBeUndefined()
    expect(out.modelRef).toBeUndefined()
  })

  test('preserves the cwd and updatedAt identity fields', () => {
    const input: WizardAnswerCheckpointV1 = {
      version: WIZARD_CHECKPOINT_VERSION,
      cwd: '/agent/keep',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const out = sanitizeCheckpointAgainstCatalog(input, validModelRefs as Set<never>)
    expect(out.cwd).toBe('/agent/keep')
    expect(out.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
