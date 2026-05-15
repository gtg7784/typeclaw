import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildStaticChecks } from './checks'
import type { CheckContext } from './types'

function findCheck() {
  const checks = buildStaticChecks()
  const check = checks.find((c) => c.name === 'config.bundled-profiles')
  if (check === undefined) throw new Error('config.bundled-profiles check not registered')
  return check
}

function makeCtx(cwd: string): CheckContext {
  return { cwd, hasAgentFolder: true }
}

describe('config.bundled-profiles doctor check', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-profiles-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('ok when fast/deep/vision are all declared', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: 'openai/gpt-5.4-nano',
          fast: 'openai/gpt-5.4-nano',
          deep: 'openai/gpt-5.5',
          vision: 'openai/gpt-5.4',
        },
      }),
    )
    const result = await findCheck().run(makeCtx(cwd))
    expect(result.status).toBe('ok')
  })

  test('warns when fast is missing', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'openai/gpt-5.4-nano', deep: 'openai/gpt-5.5', vision: 'openai/gpt-5.4' } }),
    )
    const result = await findCheck().run(makeCtx(cwd))
    expect(result.status).toBe('warning')
    expect(result.details?.some((d) => d.includes('fast:'))).toBe(true)
    expect(result.details?.some((d) => d.includes('memory-logger'))).toBe(true)
  })

  test('warns when all three bundled profiles missing (only default)', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-5.4-nano' } }))
    const result = await findCheck().run(makeCtx(cwd))
    expect(result.status).toBe('warning')
    expect(result.message).toContain('3 bundled profile')
    const detailKeys = result.details?.map((d) => d.split(':')[0]) ?? []
    expect(detailKeys.sort()).toEqual(['deep', 'fast', 'vision'])
  })

  test('skips when validateConfig fails (config.valid will report the underlying error)', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json')
    const result = await findCheck().run(makeCtx(cwd))
    expect(result.status).toBe('ok')
    expect(result.message).toContain('skipped')
  })
})
