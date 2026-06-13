import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertModelCacheCompatible,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_DTYPE,
  EMBEDDING_MODEL_NAME,
  readModelSentinel,
  writeModelSentinel,
} from './embedding-model'

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'typeclaw-sentinel-'))
}

describe('model sentinel write/read round-trip', () => {
  test('writeModelSentinel stamps the full identity and readModelSentinel parses it back', async () => {
    const dir = await tmpDir()

    await writeModelSentinel(dir, { transformers: '4.2.0' })

    const sentinel = await readModelSentinel(dir)
    expect(sentinel).toEqual({
      schemaVersion: 1,
      model: EMBEDDING_MODEL_NAME,
      dtype: EMBEDDING_MODEL_DTYPE,
      dims: EMBEDDING_DIMS,
      recipe: 'e5-prefix:mean-pool:l2-normalize',
      transformers: '4.2.0',
    })
  })

  test('the sentinel lands at .typeclaw-model.json so the container reads a stable filename', async () => {
    const dir = await tmpDir()

    await writeModelSentinel(dir, { transformers: '4.2.0' })

    const raw = await readFile(join(dir, '.typeclaw-model.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ transformers: '4.2.0', model: EMBEDDING_MODEL_NAME })
  })
})

describe('readModelSentinel resilience', () => {
  test('returns null when the file is absent — never throws, so the caller decides the policy', async () => {
    const dir = await tmpDir()

    expect(await readModelSentinel(dir)).toBeNull()
  })

  test('returns null for malformed JSON instead of throwing a parse error', async () => {
    const dir = await tmpDir()
    await writeFile(join(dir, '.typeclaw-model.json'), '{not json', 'utf8')

    expect(await readModelSentinel(dir)).toBeNull()
  })

  test('returns null for a wrong-schema sentinel (e.g. a future schemaVersion or missing field)', async () => {
    const dir = await tmpDir()
    await writeFile(join(dir, '.typeclaw-model.json'), JSON.stringify({ schemaVersion: 2, model: 'x' }), 'utf8')

    expect(await readModelSentinel(dir)).toBeNull()
  })
})

describe('assertModelCacheCompatible', () => {
  test('passes when the cache identity matches the container expectation', async () => {
    const dir = await tmpDir()
    await writeModelSentinel(dir, { transformers: '4.2.0' })

    await expect(assertModelCacheCompatible(dir, { transformers: '4.2.0' })).resolves.toBeUndefined()
  })

  test('throws naming the transformers drift when host produced a different version than the container expects', async () => {
    const dir = await tmpDir()
    await writeModelSentinel(dir, { transformers: '4.2.0' })

    await expect(assertModelCacheCompatible(dir, { transformers: '4.3.0' })).rejects.toThrow(
      /cache has "4\.2\.0", container expects "4\.3\.0"/,
    )
  })

  test('throws with a refresh hint when the sentinel is absent — a stale/hand-copied cache must not silently load', async () => {
    const dir = await tmpDir()

    await expect(assertModelCacheCompatible(dir, { transformers: '4.2.0' })).rejects.toThrow(
      /missing or has an unreadable .* Re-run `typeclaw start`/s,
    )
  })

  test('detects a model/dtype drift even when the transformers version agrees', async () => {
    const dir = await tmpDir()
    await writeFile(
      join(dir, '.typeclaw-model.json'),
      JSON.stringify({
        schemaVersion: 1,
        model: 'some/other-model',
        dtype: 'fp32',
        dims: 1024,
        recipe: 'e5-prefix:mean-pool:l2-normalize',
        transformers: '4.2.0',
      }),
      'utf8',
    )

    await expect(assertModelCacheCompatible(dir, { transformers: '4.2.0' })).rejects.toThrow(/model:|dtype:|dims:/)
  })
})
