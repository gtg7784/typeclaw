import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, homeRoot, lockfilePath, logfilePath, pidfilePath, socketPath } from './paths'

let home: string
let prev: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-paths-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
})

afterEach(async () => {
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

describe('paths', () => {
  test('homeRoot honors TYPECLAW_HOME override', () => {
    expect(homeRoot()).toBe(home)
  })

  test('all daemon paths land under TYPECLAW_HOME', () => {
    expect(socketPath()).toBe(join(home, 'run', 'portbrokerd.sock'))
    expect(pidfilePath()).toBe(join(home, 'run', 'portbrokerd.pid'))
    expect(lockfilePath()).toBe(join(home, 'run', 'portbrokerd.lock'))
    expect(logfilePath()).toBe(join(home, 'log', 'portbrokerd.log'))
  })

  test('ensureDirs creates run/ and log/', async () => {
    await ensureDirs()
    expect(existsSync(join(home, 'run'))).toBe(true)
    expect(existsSync(join(home, 'log'))).toBe(true)
  })
})
