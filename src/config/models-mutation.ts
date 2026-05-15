import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { configSchema, loadConfigSync, validateConfig } from './config'
import {
  KNOWN_PROVIDERS,
  listKnownModelRefs,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
} from './providers'
import { isProviderConfigured } from './providers-mutation'

const CONFIG_FILE = 'typeclaw.json'

export type ModelProfileEntry = {
  profile: string
  ref: KnownModelRef
  providerId: KnownProviderId
  isDefault: boolean
  credentialStatus: 'available' | 'missing-credentials'
}

export type ModelMutationResult = { ok: true } | { ok: false; reason: string }

export function listModelProfiles(cwd: string, env: NodeJS.ProcessEnv = process.env): ModelProfileEntry[] {
  const models = loadConfigSync(cwd).models
  const out: ModelProfileEntry[] = []
  for (const [profile, ref] of Object.entries(models)) {
    const providerId = providerForModelRef(ref)
    out.push({
      profile,
      ref,
      providerId,
      isDefault: profile === 'default',
      credentialStatus: hasUsableCredential(cwd, providerId, env) ? 'available' : 'missing-credentials',
    })
  }
  // `default` always first; remaining profiles alphabetical so output is stable.
  out.sort((a, b) => {
    if (a.isDefault) return -1
    if (b.isDefault) return 1
    return a.profile.localeCompare(b.profile)
  })
  return out
}

export function listAvailableModelRefs(): KnownModelRef[] {
  return listKnownModelRefs()
}

export function isKnownModelRef(value: string): value is KnownModelRef {
  return (listKnownModelRefs() as ReadonlyArray<string>).includes(value)
}

// `set` is the canonical mutation for both creating a new profile and updating
// an existing one (mirrors how `models.<profile>` works in the schema).
// Refuses unknown model refs and providers without credentials (unless
// `force: true`) so a write can't leave the agent in a state where the next
// session start crashes with a missing-credential error.
export type SetProfileOptions = {
  force?: boolean
  env?: NodeJS.ProcessEnv
}

export function setProfile(
  cwd: string,
  profile: string,
  ref: string,
  options: SetProfileOptions = {},
): ModelMutationResult {
  const trimmed = profile.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Profile name cannot be empty.' }
  }
  if (!isKnownModelRef(ref)) {
    return {
      ok: false,
      reason: `Unknown model "${ref}". Run \`typeclaw model list --available\` to see valid options.`,
    }
  }
  const providerId = providerForModelRef(ref)
  if (options.force !== true && !hasUsableCredential(cwd, providerId, options.env ?? process.env)) {
    return {
      ok: false,
      reason: `Provider "${providerId}" has no credentials. Run \`typeclaw provider add ${providerId}\` first, or pass --force to write anyway.`,
    }
  }

  return writeProfile(cwd, trimmed, ref)
}

// `add` is just `set` with a uniqueness guard; users who want "update" should
// reach for `set`. Keeping it separate so the CLI can route distinct error
// messages without leaking force-overwrite as a happy path.
export function addProfile(
  cwd: string,
  profile: string,
  ref: string,
  options: SetProfileOptions = {},
): ModelMutationResult {
  const existing = readModelsRaw(cwd)
  if (existing !== null && profile in existing) {
    return {
      ok: false,
      reason: `Profile "${profile}" already exists. Use \`typeclaw model set ${profile} ${ref}\` to update it.`,
    }
  }
  return setProfile(cwd, profile, ref, options)
}

// `default` is required by the schema (`modelsSchema.refine`). Removing it
// would make the file unparseable, so we reject with a precise hint instead of
// letting the next `validateConfig` failure confuse the user. To change the
// default model, the user runs `typeclaw model set default <ref>`.
export function removeProfile(cwd: string, profile: string): ModelMutationResult {
  if (profile === 'default') {
    return {
      ok: false,
      reason:
        'Cannot remove the `default` profile. Use `typeclaw model set default <ref>` to change the default model.',
    }
  }
  const existing = readModelsRaw(cwd)
  if (existing === null) {
    return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
  }
  if (!(profile in existing)) {
    return { ok: false, reason: `Profile "${profile}" not found in ${CONFIG_FILE}.` }
  }
  const next = { ...existing }
  delete next[profile]
  return writeModels(cwd, next)
}

function writeProfile(cwd: string, profile: string, ref: KnownModelRef): ModelMutationResult {
  const existing = readModelsRaw(cwd)
  const next = existing === null ? { default: ref } : { ...existing, [profile]: ref }
  if (existing === null && profile !== 'default') {
    next.default = ref
  }
  return writeModels(cwd, next)
}

function writeModels(cwd: string, models: Record<string, string>): ModelMutationResult {
  const path = join(cwd, CONFIG_FILE)
  let parsed: Record<string, unknown>
  try {
    const raw = readFileSync(path, 'utf8')
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  parsed.models = models
  const check = configSchema.safeParse(parsed)
  if (!check.success) {
    return {
      ok: false,
      reason: `models block would be invalid: ${check.error.issues.map((i) => i.message).join('; ')}`,
    }
  }
  try {
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `Failed to write ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  // Final schema-pass for parity with every other host-side mutation that runs
  // through validateConfig. Mount checks etc. should never fail here because
  // we only touched `models`, but if the file was already in a bad state we
  // want to surface that instead of leaving the user wondering why `reload`
  // fails.
  const validation = validateConfig(cwd)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  return { ok: true }
}

function readModelsRaw(cwd: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { models?: Record<string, string> }
    return parsed.models ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hasUsableCredential(cwd: string, providerId: KnownProviderId, env: NodeJS.ProcessEnv): boolean {
  const provider = KNOWN_PROVIDERS[providerId]
  if (provider.apiKeyEnv !== null) {
    const fromEnv = env[provider.apiKeyEnv]
    if (fromEnv !== undefined && fromEnv !== '') return true
  }
  return isProviderConfigured(cwd, providerId)
}
