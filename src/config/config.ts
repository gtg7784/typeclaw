import type { Model } from '@mariozechner/pi-ai'
import { z } from 'zod'

import { KNOWN_PROVIDERS, listKnownModelRefs, type KnownModelRef, type KnownProviderId } from './providers'

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
  // Required so users explicitly opt in to host file access and so the absence
  // of mounts is a deliberate choice, not a forgotten field. Empty array is
  // valid and is what `typeclaw init` writes.
  mounts: z.array(mountSchema),
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
