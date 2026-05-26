import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendOrReplaceEnvKey, hasEnvKey, readEnvFile } from './env-file'

describe('readEnvFile', () => {
  test('returns an empty map when .env is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    expect(readEnvFile(cwd).size).toBe(0)
  })

  test('parses KEY=value lines, skipping blanks and comments', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '# a comment\n\nFOO=bar\nBAZ=qux\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.get('FOO')).toBe('bar')
    expect(env.get('BAZ')).toBe('qux')
    expect(env.size).toBe(2)
  })

  test('preserves quotes verbatim (matches docker --env-file semantics)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'QUOTED="hello"\n', 'utf8')
    expect(readEnvFile(cwd).get('QUOTED')).toBe('"hello"')
  })

  test('treats only the first `=` as the separator', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EQUATION=a=b=c\n', 'utf8')
    expect(readEnvFile(cwd).get('EQUATION')).toBe('a=b=c')
  })

  test('skips lines without `=` and lines starting with `=`', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'STRAY_LINE\n=noKey\nOK=yes\n', 'utf8')
    const env = readEnvFile(cwd)
    expect(env.size).toBe(1)
    expect(env.get('OK')).toBe('yes')
  })
})

describe('hasEnvKey', () => {
  test('returns false when the key is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'OTHER=value\n', 'utf8')
    expect(hasEnvKey(cwd, 'MISSING')).toBe(false)
  })

  test('returns false when the key is present but empty', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EMPTY=\n', 'utf8')
    expect(hasEnvKey(cwd, 'EMPTY')).toBe(false)
  })

  test('returns true when the key has a non-empty value', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'FILLED=something\n', 'utf8')
    expect(hasEnvKey(cwd, 'FILLED')).toBe(true)
  })

  test('returns false when .env is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    expect(hasEnvKey(cwd, 'ANY')).toBe(false)
  })
})

describe('appendOrReplaceEnvKey', () => {
  test('creates .env with KEY=value when the file is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    appendOrReplaceEnvKey(cwd, 'FOO', 'bar')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('FOO=bar\n')
  })

  test('appends a new key after existing keys', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('EXISTING=keep\nFRESH=value\n')
  })

  test('replaces an existing key in place, preserving surrounding lines', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), '# header\nFIRST=a\nTARGET=old\nLAST=z\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'TARGET', 'new')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('# header\nFIRST=a\nTARGET=new\nLAST=z\n')
  })

  test('does not strip or add quotes around the value', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    appendOrReplaceEnvKey(cwd, 'TOKEN', 'eyJhbGc.abc.def')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('TOKEN=eyJhbGc.abc.def\n')
  })

  test('handles a file without a trailing newline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('EXISTING=keep\nFRESH=value\n')
  })

  test('does not double up trailing blank lines when appending', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-envfile-'))
    await writeFile(join(cwd, '.env'), 'EXISTING=keep\n', 'utf8')
    appendOrReplaceEnvKey(cwd, 'FRESH', 'value')
    const out = await readFile(join(cwd, '.env'), 'utf8')
    expect(out).toBe('EXISTING=keep\nFRESH=value\n')
    expect(out.split('\n').filter((line) => line === '').length).toBe(1)
  })
})
