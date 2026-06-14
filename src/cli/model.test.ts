import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ModelOption } from '@/init/models-dev'

import { resolveExplicitRef } from './model'

const CLI_ENTRY = join(import.meta.dir, 'index.ts')
const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('resolveExplicitRef carries catalog metadata for non-interactive set/add', () => {
  function catalogWith(option: ModelOption): () => Promise<{ options: ModelOption[] }> {
    return async () => ({ options: [option] })
  }

  const liveOption: ModelOption = {
    ref: 'fireworks/brand-new-model',
    providerId: 'fireworks',
    providerName: 'Fireworks',
    modelId: 'brand-new-model',
    modelName: 'Brand New Model',
    reasoning: true,
    contextWindow: 256000,
    maxTokens: 32000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    curated: false,
    supportsVision: true,
  }

  test('curated ref persists no custom metadata (resolves from KNOWN_PROVIDERS)', async () => {
    const picked = await resolveExplicitRef('openai/gpt-5.4-nano', catalogWith(liveOption))
    expect(picked.ref).toBe('openai/gpt-5.4-nano')
    expect(picked.meta).toBeUndefined()
  })

  test('non-curated ref found in the catalog carries its metadata', async () => {
    const picked = await resolveExplicitRef('fireworks/brand-new-model', catalogWith(liveOption))
    expect(picked.ref).toBe('fireworks/brand-new-model')
    expect(picked.meta).toEqual({
      name: 'Brand New Model',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 256000,
      maxTokens: 32000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    })
  })

  test('non-curated ref missing from the catalog persists the ref without metadata', async () => {
    const picked = await resolveExplicitRef('fireworks/unknown-model', catalogWith(liveOption))
    expect(picked.ref).toBe('fireworks/unknown-model')
    expect(picked.meta).toBeUndefined()
  })
})

describe('typeclaw model list survives broken typeclaw.json', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-list-broken-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runModelList(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'model', 'list'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  test('exits 0 and renders the default profile when typeclaw.json is malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), 'NOT JSON AT ALL {{{')
    const { exitCode, stdout, stderr } = await runModelList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    expect(stdout).toContain('default')
    expect(stderr).toMatch(/not valid JSON/)
    expect(stderr).toMatch(/diagnostic commands still work/)
  })

  test('exits 0 and renders the default profile when typeclaw.json is schema-invalid', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const { exitCode, stdout, stderr } = await runModelList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    expect(stdout).toContain('default')
    expect(stderr).toMatch(/typeclaw\.json is invalid/)
  })
})

describe('typeclaw model list migrates a pre-0.20.0 v1 secrets.json on first host invocation', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-model-list-v1-secrets-'))
    await symlink(join(REPO_ROOT, 'node_modules'), join(cwd, 'node_modules'), 'dir')
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({}))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  const runModelList = () => runCli(['model', 'list'])

  const writeV1Secrets = () =>
    writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 1,
        llm: { fireworks: { type: 'api_key', key: 'fpk_test' } },
        channels: { 'discord-bot': { DISCORD_BOT_TOKEN: 'dtok' } },
      }),
    )

  test('exits 0 and rewrites secrets.json to the v2 envelope on disk', async () => {
    await writeV1Secrets()

    const { exitCode, stdout } = await runModelList()

    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROFILE')
    const migrated = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(migrated.version).toBe(2)
    expect(migrated.providers.fireworks).toEqual({ type: 'api_key', key: { value: 'fpk_test' } })
    expect(migrated.channels['discord-bot']).toEqual({ token: { value: 'dtok' } })
  })

  test('leaves an already-v2 secrets.json untouched', async () => {
    const v2 = { version: 2, providers: {}, channels: {} }
    await writeFile(join(cwd, 'secrets.json'), JSON.stringify(v2))

    const { exitCode } = await runModelList()

    expect(exitCode).toBe(0)
    const after = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(after).toEqual(v2)
  })

  test('does not migrate or warn on informational --help invocations', async () => {
    await writeV1Secrets()

    const { exitCode, stderr } = await runCli(['--help'])

    expect(exitCode).toBe(0)
    expect(stderr).not.toMatch(/migration/i)
    const untouched = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8'))
    expect(untouched.version).toBe(1)
  })
})
