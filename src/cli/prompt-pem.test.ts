import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  CANCEL_SYMBOL,
  createReadlineLineReader,
  readPrivateKeyFromLines,
  resolvePrivateKeyInput,
  type ReadLineFn,
} from './prompt-pem'

function fromLines(lines: (string | typeof CANCEL_SYMBOL)[]): ReadLineFn {
  let i = 0
  return async () => {
    if (i >= lines.length) return CANCEL_SYMBOL
    const v = lines[i++]
    return v as string | typeof CANCEL_SYMBOL
  }
}

const SAMPLE_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEAtest1234',
  'AAAAAAAAAAAAAAAAAAAAAAAAA',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

describe('readPrivateKeyFromLines', () => {
  test('returns single-line input verbatim when it is not a PEM block', async () => {
    const result = await readPrivateKeyFromLines(fromLines(['/path/to/key.pem']))
    expect(result).toBe('/path/to/key.pem')
  })

  test('returns escaped-PEM single-line input verbatim', async () => {
    const escaped = '-----BEGIN RSA PRIVATE KEY-----\\nABC\\n-----END RSA PRIVATE KEY-----'
    const result = await readPrivateKeyFromLines(fromLines([escaped]))
    expect(result).toBe(escaped)
  })

  test('captures a full multi-line PEM block (the bug this fixes)', async () => {
    const lines = SAMPLE_PEM.split('\n')
    const result = await readPrivateKeyFromLines(fromLines(lines))
    expect(result).toBe(`${SAMPLE_PEM}\n`)
  })

  test('handles PEM with leading blank lines (stray Enter before paste)', async () => {
    const lines = ['', '', ...SAMPLE_PEM.split('\n')]
    const result = await readPrivateKeyFromLines(fromLines(lines))
    expect(result).toBe(`${SAMPLE_PEM}\n`)
  })

  test('handles EC PRIVATE KEY header variant', async () => {
    const ec = ['-----BEGIN EC PRIVATE KEY-----', 'data', '-----END EC PRIVATE KEY-----'].join('\n')
    const result = await readPrivateKeyFromLines(fromLines(ec.split('\n')))
    expect(result).toBe(`${ec}\n`)
  })

  test('handles generic PRIVATE KEY (PKCS#8) header', async () => {
    const pkcs8 = ['-----BEGIN PRIVATE KEY-----', 'data', '-----END PRIVATE KEY-----'].join('\n')
    const result = await readPrivateKeyFromLines(fromLines(pkcs8.split('\n')))
    expect(result).toBe(`${pkcs8}\n`)
  })

  test('strips trailing CR/whitespace from each line (CRLF paste)', async () => {
    const lines = ['-----BEGIN RSA PRIVATE KEY-----\r', 'data\r', '-----END RSA PRIVATE KEY-----\r']
    const result = await readPrivateKeyFromLines(fromLines(lines))
    expect(result).toBe(`${SAMPLE_PEM.split('\n').slice(0, 1).join('')}\ndata\n-----END RSA PRIVATE KEY-----\n`)
  })

  test('returns CANCEL_SYMBOL when reader cancels mid-block', async () => {
    const result = await readPrivateKeyFromLines(fromLines(['-----BEGIN RSA PRIVATE KEY-----', CANCEL_SYMBOL]))
    expect(result).toBe(CANCEL_SYMBOL)
  })

  test('returns CANCEL_SYMBOL when reader cancels before any input', async () => {
    const result = await readPrivateKeyFromLines(fromLines([CANCEL_SYMBOL]))
    expect(result).toBe(CANCEL_SYMBOL)
  })
})

describe('resolvePrivateKeyInput', () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'typeclaw-pem-'))
  })

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  test('passes through a real multi-line PEM unchanged', async () => {
    const out = await resolvePrivateKeyInput(SAMPLE_PEM)
    expect(out).toBe(SAMPLE_PEM)
  })

  test('unescapes a single-line escaped PEM', async () => {
    const escaped = SAMPLE_PEM.replace(/\n/g, '\\n')
    const out = await resolvePrivateKeyInput(escaped)
    expect(out).toBe(SAMPLE_PEM)
  })

  test('does NOT unescape a multi-line PEM that happens to contain \\n', async () => {
    const mixed = `${SAMPLE_PEM}\nliteral\\nshould stay`
    const out = await resolvePrivateKeyInput(mixed)
    expect(out).toBe(mixed)
  })

  test('reads PEM from a file path', async () => {
    const path = join(tmp, 'key.pem')
    await writeFile(path, SAMPLE_PEM, 'utf8')
    const out = await resolvePrivateKeyInput(path)
    expect(out).toBe(SAMPLE_PEM)
  })

  test('throws ENOENT for a non-existent path that is not a PEM', async () => {
    await expect(resolvePrivateKeyInput(join(tmp, 'does-not-exist.pem'))).rejects.toThrow()
  })
})

describe('createReadlineLineReader', () => {
  test('yields lines from a Readable stream then cancels on close', async () => {
    const input = Readable.from([SAMPLE_PEM + '\n'])
    const reader = createReadlineLineReader(input)
    const lines = SAMPLE_PEM.split('\n')
    for (const expected of lines) {
      const got = await reader.next()
      expect(got).toBe(expected)
    }
    const after = await reader.next()
    expect(after).toBe(CANCEL_SYMBOL)
  })

  test('queues lines when consumer reads after they arrive', async () => {
    const input = Readable.from(['one\ntwo\nthree\n'])
    const reader = createReadlineLineReader(input)
    await new Promise((r) => setTimeout(r, 10))
    expect(await reader.next()).toBe('one')
    expect(await reader.next()).toBe('two')
    expect(await reader.next()).toBe('three')
  })
})
