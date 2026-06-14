import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitSystemFileSync } from '@/git/system-commit'

import { configSchema, loadConfigSyncOrDefaults, validateConfig, type CustomModelMeta } from './config'
import {
  KNOWN_PROVIDERS,
  isKnownModelRef,
  isModelRef,
  listKnownModelRefs,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
  type ModelRef,
} from './providers'
import { isProviderConfigured, listConfiguredProviders } from './providers-mutation'

const CONFIG_FILE = 'typeclaw.json'

export type ModelProfileEntry = {
  profile: string
  // Head of the fallback chain. Kept under the legacy `ref` name so callers
  // that only care about the active model (the common case) don't need to
  // dereference `refs[0]`. The chain itself is exposed as `refs`.
  ref: ModelRef
  refs: ModelRef[]
  providerId: KnownProviderId
  // Credential status for every provider referenced by the chain. The chain's
  // overall status is `available` only when every entry resolves; otherwise
  // it is `missing-credentials`, and `missingProviders` names which.
  missingProviders: KnownProviderId[]
  isDefault: boolean
  credentialStatus: 'available' | 'missing-credentials'
}

export type ModelMutationResult = { ok: true } | { ok: false; reason: string }

// `listModelProfiles` is the read-only path behind `typeclaw model list`, a
// diagnostic command. It routes through `loadConfigSyncOrDefaults` (same
// soft-fail pattern as `typeclaw status` / `doctor`, PR #288) so a broken
// `typeclaw.json` doesn't crash the command users reach for to see what
// model config the agent thinks it has. Mutation paths (`setProfile`,
// `addProfile`, `removeProfile`) stay on the strict gate via `validateConfig`
// in `writeModels`, because writing through a broken-on-disk file would
// silently land schema-invalid bytes.
export function listModelProfiles(cwd: string, env: NodeJS.ProcessEnv = process.env): ModelProfileEntry[] {
  const models = loadConfigSyncOrDefaults(cwd).models
  const out: ModelProfileEntry[] = []
  for (const [profile, refs] of Object.entries(models)) {
    const headRef = refs[0]!
    const providerId = providerForModelRef(headRef)
    const missingProviders = uniqueProviders(refs).filter((p) => !hasUsableCredential(cwd, p, env))
    out.push({
      profile,
      ref: headRef,
      refs,
      providerId,
      missingProviders,
      isDefault: profile === 'default',
      credentialStatus: missingProviders.length === 0 ? 'available' : 'missing-credentials',
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

function uniqueProviders(refs: ReadonlyArray<ModelRef>): KnownProviderId[] {
  const seen = new Set<KnownProviderId>()
  const out: KnownProviderId[] = []
  for (const r of refs) {
    const p = providerForModelRef(r)
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

export function listAvailableModelRefs(): KnownModelRef[] {
  return listKnownModelRefs()
}

// Subset of `listAvailableModelRefs()` filtered to providers with a usable
// credential in this agent folder — either a `secrets.json#providers.<id>`
// entry (api-key OR oauth) or a credential resolvable from the process env
// via the provider's canonical env-var name. Used by `typeclaw model set`'s
// interactive picker so users only see models they can actually run; the
// CLI surfaces an explicit "add provider" sentinel when the result is empty
// or when the user wants to wire a new one.
//
// Ordering preserves `listKnownModelRefs()` (provider-table declaration
// order, then per-provider model order) so the picker reads stably across
// invocations.
export function listRegisteredModelRefs(cwd: string, env: NodeJS.ProcessEnv = process.env): KnownModelRef[] {
  const registered = new Set<KnownProviderId>()
  for (const entry of listConfiguredProviders(cwd, env)) {
    if (entry.known) registered.add(entry.id as KnownProviderId)
  }
  return listKnownModelRefs().filter((ref) => registered.has(providerForModelRef(ref)))
}

export { isKnownModelRef }

// `set` is the canonical mutation for both creating a new profile and updating
// an existing one (mirrors how `models.<profile>` works in the schema).
// Refuses unknown model refs and providers without credentials (unless
// `force: true`) so a write can't leave the agent in a state where the next
// session start crashes with a missing-credential error.
export type SetProfileOptions = {
  force?: boolean
  env?: NodeJS.ProcessEnv
  meta?: CustomModelMeta
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
  if (!isModelRef(ref)) {
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

  const existingBefore = readModelsRaw(cwd)
  const verb = existingBefore !== null && trimmed in existingBefore ? 'set' : 'add'
  const customModel = !isKnownModelRef(ref) && options.meta !== undefined ? { ref, meta: options.meta } : undefined
  return writeProfile(cwd, trimmed, ref, `model: ${verb} ${trimmed} → ${ref}`, customModel)
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
  return writeModels(cwd, next, `model: remove ${profile}`)
}

function writeProfile(
  cwd: string,
  profile: string,
  ref: ModelRef,
  message: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
): ModelMutationResult {
  const existing = readModelsRaw(cwd)
  const next: Record<string, string | string[]> = existing === null ? { default: ref } : { ...existing, [profile]: ref }
  if (existing === null && profile !== 'default') {
    next.default = ref
  }
  return writeModels(cwd, next, message, customModel)
}

function writeModels(
  cwd: string,
  models: Record<string, string | string[]>,
  commitMessage: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
): ModelMutationResult {
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
  if (customModel !== undefined) {
    const existingCustomModels = isObjectRecord(parsed.customModels) ? parsed.customModels : {}
    parsed.customModels = { ...existingCustomModels, [customModel.ref]: customModel.meta }
  }
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
  // Auto-commit so the agent folder is never silently dirty after a CLI
  // config mutation. Same pattern as `persistMigratedConfig` and cron
  // migrations: `commitSystemFileSync` no-ops on non-git folders, missing
  // Bun, and clean files, so callers outside a git repo pay zero cost.
  commitSystemFileSync(cwd, CONFIG_FILE, commitMessage)
  return { ok: true }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Returns the raw `models` block from disk in its on-disk shape: each value
// is `string | string[]` (the user-facing schema). Writers preserve whichever
// shape was already present for profiles they don't touch — converting a
// hand-authored fallback chain back to a single string would silently drop
// the fallback.
function readModelsRaw(cwd: string): Record<string, string | string[]> | null {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { models?: Record<string, string | string[]> }
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
