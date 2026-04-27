import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Model } from '@mariozechner/pi-ai'
import { z } from 'zod'

import { KNOWN_PROVIDERS, listKnownModelRefs, type KnownModelRef, type KnownProviderId } from './providers'

const CONFIG_FILE = 'typeclaw.json'

const knownModelRefs = listKnownModelRefs() as [KnownModelRef, ...KnownModelRef[]]

// T9 keypad: T=8, Y=9, P=7, E=3
const DEFAULT_PORT = 8973
const DEFAULT_MEMORY_IDLE_MS = 30_000

// Mount names land on disk as `mounts/<name>` inside the agent folder, so they
// share a namespace with regular filenames. Restricting to lowercase
// alphanumerics + `-`/`_` keeps them shell-safe and avoids accidental shadowing
// of files like `mounts/.git` or `mounts/Hello`.
const MOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

export const mountSchema = z.object({
  name: z.string().regex(MOUNT_NAME_PATTERN, 'mount name must be lowercase alphanumeric with - or _'),
  path: z.string().min(1),
  readOnly: z.boolean().default(false),
  description: z.string().optional(),
})

export type Mount = z.infer<typeof mountSchema>

export const configSchema = z.object({
  $schema: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  model: z.enum(knownModelRefs).default('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'), // FIXME: TEMP default
  memory: z
    .object({
      idleMs: z.number().int().min(1000).default(DEFAULT_MEMORY_IDLE_MS),
    })
    .default({ idleMs: DEFAULT_MEMORY_IDLE_MS }),
  // Defaults to `[]` so configs predating the field still load. `typeclaw init`
  // writes `"mounts": []` explicitly, but a missing field is treated the same
  // way (no host paths exposed) rather than failing the whole config load.
  mounts: z.array(mountSchema).default([]),
})

export type Config = z.infer<typeof configSchema>

export function resolveModel(ref: KnownModelRef): Model<'openai-completions'> {
  // Model IDs can contain '/', so split only on the first separator.
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash) as KnownProviderId
  const modelId = ref.slice(slash + 1)
  return KNOWN_PROVIDERS[providerId].models[modelId as never]
}

// FIXME: TEMP — hard-coded dev defaults; replace with loader.
export const config: Config = configSchema.parse({ mounts: [] })

export type ValidateConfigResult = { ok: true } | { ok: false; reason: string }

// Missing file → ok (matches `loadMounts` in src/container/up.ts; `isInitialized`
// is the dedicated check for "not initialized"). Present but invalid → fail, so
// `restart` doesn't stop the container before discovering the config is broken.
export function validateConfig(cwd: string): ValidateConfigResult {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return { ok: true }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${detail}` }
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    return { ok: false, reason: `${CONFIG_FILE} is invalid: ${formatZodError(result.error)}` }
  }

  return { ok: true }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
