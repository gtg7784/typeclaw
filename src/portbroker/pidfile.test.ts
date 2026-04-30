import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureLogDir, logfilePath, pidfilePath, readPidfile, removePidfile, writePidfile } from './pidfile'

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-pidfile-'))
  prevHome = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('pidfilePath', () => {
  test('places pidfile under TYPECLAW_HOME/run with stable suffix', () => {
    expect(pidfilePath('coder')).toBe(join(home, 'run', 'coder-portbroker.pid'))
  })

  test('logfile lives under TYPECLAW_HOME/log', () => {
    expect(logfilePath('coder')).toBe(join(home, 'log', 'coder-portbroker.log'))
  })
})

describe('writePidfile + readPidfile', () => {
  test('roundtrip returns the same pid for a live process', async () => {
    await writePidfile('coder', process.pid)
    expect(await readPidfile('coder')).toBe(process.pid)
  })

  test('readPidfile returns null when file is missing', async () => {
    expect(await readPidfile('nope')).toBeNull()
  })

  test('readPidfile returns null when pid is stale (no such process)', async () => {
    // PID 0x7FFFFFFF is reliably absent on every Unix kernel we target.
    await writePidfile('coder', 0x7fffffff)
    expect(await readPidfile('coder')).toBeNull()
  })

  test('readPidfile returns null when file content is not a number', async () => {
    await mkdir(join(home, 'run'), { recursive: true })
    await writeFile(pidfilePath('coder'), 'not-a-pid\n')
    expect(await readPidfile('coder')).toBeNull()
  })

  test('writePidfile creates the run/ directory if missing', async () => {
    await writePidfile('fresh', process.pid)
    const raw = await readFile(pidfilePath('fresh'), 'utf8')
    expect(raw.trim()).toBe(String(process.pid))
  })
})

describe('removePidfile', () => {
  test('deletes an existing pidfile', async () => {
    await writePidfile('coder', process.pid)
    await removePidfile('coder')
    expect(await readPidfile('coder')).toBeNull()
  })

  test('is idempotent when no pidfile exists', async () => {
    await removePidfile('coder')
    await removePidfile('coder')
    expect(await readPidfile('coder')).toBeNull()
  })
})

describe('ensureLogDir', () => {
  test('returns the log file path and creates the parent dir', async () => {
    const path = await ensureLogDir('coder')
    expect(path).toBe(logfilePath('coder'))
    await writeFile(path, 'hello\n')
    expect((await readFile(path, 'utf8')).trim()).toBe('hello')
  })
})
