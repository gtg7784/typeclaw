import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const EMBEDDING_MODEL_NAME = 'Xenova/multilingual-e5-base'
export const EMBEDDING_MODEL_DTYPE = 'q8'
export const EMBEDDING_DIMS = 768

// The embedding recipe that makes two vectors comparable: E5 query/passage
// prefixing + mean pooling + L2 normalize. Stamped in the sentinel (not folded
// into EMBEDDING_MODEL_ID, which is a stored-row filter — changing the ID would
// invalidate every existing vector row). A future pooling/normalize change
// bumps this string so a stale cache fails the sentinel loudly.
export const EMBEDDING_RECIPE = 'e5-prefix:mean-pool:l2-normalize'

// Stored-row identity = name@dtype. Used by the vector store to filter rows
// from an incompatible model/dtype variant out of cosine scans.
export const EMBEDDING_MODEL_ID = `${EMBEDDING_MODEL_NAME}@${EMBEDDING_MODEL_DTYPE}`

const SENTINEL_FILE = '.typeclaw-model.json'

export type ModelSentinel = {
  schemaVersion: 1
  model: string
  dtype: string
  dims: number
  recipe: string
  transformers: string
}

function sentinelPath(dir: string): string {
  return join(dir, SENTINEL_FILE)
}

function expectedSentinel(transformers: string): Omit<ModelSentinel, 'transformers'> & { transformers: string } {
  return {
    schemaVersion: 1,
    model: EMBEDDING_MODEL_NAME,
    dtype: EMBEDDING_MODEL_DTYPE,
    dims: EMBEDDING_DIMS,
    recipe: EMBEDDING_RECIPE,
    transformers,
  }
}

// Atomic write-then-rename so a container reader can never observe a partial
// JSON file mid-write. Called host-side after a successful model download,
// inside the proper-lockfile critical section.
export async function writeModelSentinel(dir: string, input: { transformers: string }): Promise<void> {
  const sentinel = expectedSentinel(input.transformers)
  const tmp = `${sentinelPath(dir)}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(sentinel, null, 2)}\n`, 'utf8')
  await rename(tmp, sentinelPath(dir))
}

export async function readModelSentinel(dir: string): Promise<ModelSentinel | null> {
  let raw: string
  try {
    raw = await readFile(sentinelPath(dir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModelSentinel>
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.model !== 'string' ||
      typeof parsed.dtype !== 'string' ||
      typeof parsed.dims !== 'number' ||
      typeof parsed.recipe !== 'string' ||
      typeof parsed.transformers !== 'string'
    ) {
      return null
    }
    return parsed as ModelSentinel
  } catch {
    return null
  }
}

// Throws a TypeClaw-authored error (naming observed vs expected identity, with
// the fix) BEFORE the container's `local_files_only` pipeline load — so a
// host/container drift surfaces as a clear "refresh the cache" message instead
// of a cryptic missing-file miss, OR worse, a stale file that loads against a
// different producer's layout and silently returns garbage vectors. Absent
// sentinel is a hard failure: host ensureModels() writes it before `docker
// run` in the same `typeclaw start`, so a missing one means the mount is wrong
// or the cache was hand-copied — exactly the case we must not paper over.
export async function assertModelCacheCompatible(dir: string, expected: { transformers: string }): Promise<void> {
  const sentinel = await readModelSentinel(dir)
  const want = expectedSentinel(expected.transformers)
  if (sentinel === null) {
    throw new Error(
      `TypeClaw model cache at ${dir} is missing or has an unreadable ${SENTINEL_FILE}, so compatibility with ` +
        `this container cannot be verified. Re-run \`typeclaw start\` to refresh the model cache; if it was copied ` +
        `manually, delete it and start again.`,
    )
  }
  const mismatches = describeMismatches(sentinel, want)
  if (mismatches.length > 0) {
    throw new Error(
      `TypeClaw model cache at ${dir} is incompatible with this container (${mismatches.join('; ')}). ` +
        `Re-run \`typeclaw start\` to refresh the model cache.`,
    )
  }
}

function describeMismatches(got: ModelSentinel, want: ModelSentinel): string[] {
  const fields: Array<keyof ModelSentinel> = ['model', 'dtype', 'dims', 'recipe', 'transformers']
  return fields
    .filter((field) => got[field] !== want[field])
    .map(
      (field) => `${field}: cache has ${JSON.stringify(got[field])}, container expects ${JSON.stringify(want[field])}`,
    )
}
