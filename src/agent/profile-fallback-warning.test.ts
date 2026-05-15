import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { __resetProfileFallbackWarningsForTesting, createSessionWithDispose } from './index'

describe('profile-fallback warning is rate-limited (Oracle review Bug 2 / Design 1)', () => {
  let prevCwd: string
  let prevNodeEnv: string | undefined
  let prevOpenai: string | undefined
  let cwd: string
  let warnings: string[]
  let originalWarn: typeof console.warn

  beforeEach(async () => {
    prevCwd = process.cwd()
    prevNodeEnv = process.env.NODE_ENV
    prevOpenai = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-profile-warn-'))
    process.chdir(cwd)
    __resetProfileFallbackWarningsForTesting()
    __resetConfigForTesting()
    warnings = []
    originalWarn = console.warn
    console.warn = (msg: unknown) => {
      warnings.push(String(msg))
    }
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-5.4-nano' } }))
    reloadConfig(cwd)
  })

  afterEach(async () => {
    console.warn = originalWarn
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenai
    __resetProfileFallbackWarningsForTesting()
    __resetConfigForTesting()
    process.chdir(prevCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test('an unknown profile warns exactly once across repeated session creations', async () => {
    const create = async () => {
      const { session, dispose } = await createSessionWithDispose({ profile: 'nonexistent-profile' })
      session.dispose()
      await dispose()
    }
    await create()
    await create()
    await create()

    const fallbackWarnings = warnings.filter(
      (w) => w.includes('unknown model profile') && w.includes('nonexistent-profile'),
    )
    expect(fallbackWarnings.length).toBe(1)
    expect(fallbackWarnings[0]).toContain('further occurrences suppressed')
  })

  test('distinct unknown profiles each warn once', async () => {
    const create = async (profile: string) => {
      const { session, dispose } = await createSessionWithDispose({ profile })
      session.dispose()
      await dispose()
    }
    await create('typo-one')
    await create('typo-two')
    await create('typo-one')

    const one = warnings.filter((w) => w.includes('typo-one') && w.includes('unknown model profile'))
    const two = warnings.filter((w) => w.includes('typo-two') && w.includes('unknown model profile'))
    expect(one.length).toBe(1)
    expect(two.length).toBe(1)
  })

  test('omitted profile (default) does not warn', async () => {
    const { session, dispose } = await createSessionWithDispose({})
    session.dispose()
    await dispose()

    const fallbackWarnings = warnings.filter((w) => w.includes('unknown model profile'))
    expect(fallbackWarnings).toEqual([])
  })

  test('explicit "default" profile does not warn (it is by definition known)', async () => {
    const { session, dispose } = await createSessionWithDispose({ profile: 'default' })
    session.dispose()
    await dispose()

    const fallbackWarnings = warnings.filter((w) => w.includes('unknown model profile'))
    expect(fallbackWarnings).toEqual([])
  })
})
