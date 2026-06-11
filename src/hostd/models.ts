import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { env as transformersEnv, pipeline } from '@huggingface/transformers'
import lockfile from 'proper-lockfile'

import { modelsDir } from './paths'

const MODEL_NAME = 'Xenova/multilingual-e5-base'
const LOCK_RETRIES = { retries: 60, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false } as const

let ensureModelsPromise: Promise<void> | null = null
let ensureModelsPath: string | null = null

export function ensureModels(): Promise<void> {
  const dir = modelsDir()
  if (ensureModelsPath !== dir) {
    ensureModelsPath = dir
    ensureModelsPromise = null
  }
  ensureModelsPromise ??= ensureModelsLocked().catch((error: unknown) => {
    ensureModelsPromise = null
    throw error
  })
  return ensureModelsPromise
}

async function ensureModelsLocked(): Promise<void> {
  const dir = modelsDir()
  await mkdir(dir, { recursive: true })

  const release = await lockfile.lock(dir, {
    lockfilePath: join(dir, '.lock'),
    realpath: false,
    retries: LOCK_RETRIES,
    stale: 30_000,
  })
  try {
    configureTransformers(dir)
    await pipeline('feature-extraction', MODEL_NAME)
  } finally {
    await release()
  }
}

function configureTransformers(dir: string): void {
  transformersEnv.localModelPath = dir
  ;(transformersEnv as typeof transformersEnv & { cacheDir: string }).cacheDir = dir
}
