import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { Model } from '@mariozechner/pi-ai'
import { z } from 'zod'

import { channelsSchema } from '@/channels/schema'

import { KNOWN_PROVIDERS, listKnownModelRefs, type KnownModelRef, type KnownProviderId } from './providers'

const CONFIG_FILE = 'typeclaw.json'

const knownModelRefs = listKnownModelRefs() as [KnownModelRef, ...KnownModelRef[]]

// T9 keypad: T=8, Y=9, P=7, E=3
const DEFAULT_PORT = 8973

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

const portNumber = z.number().int().min(1).max(65535)

// `allow` is the discriminator between "forward everything" ('*') and a fixed
// allowlist (number[]). `deny` is only meaningful when allow === '*'; combining
// it with a number[] allow is rejected at parse time so a typo doesn't silently
// drop the deny rule. An empty allowlist (`allow: []`) is the off switch.
export const portForwardSchema = z
  .object({
    allow: z.union([z.literal('*'), z.array(portNumber)]),
    deny: z.array(portNumber).optional(),
    tailscaleServe: z.boolean().default(false),
  })
  .refine((v) => !(Array.isArray(v.allow) && v.deny !== undefined && v.deny.length > 0), {
    message: 'portForward.deny is only meaningful when allow is "*"; remove deny or set allow to "*"',
    path: ['deny'],
  })
  .default({ allow: '*', tailscaleServe: false })

export type PortForward = {
  allow: '*' | number[]
  deny?: number[]
  tailscaleServe?: boolean
}

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    model: z.enum(knownModelRefs).default('fireworks/accounts/fireworks/routers/kimi-k2p5-turbo'), // FIXME: TEMP default
    // Defaults to `[]` so the field can be omitted from `typeclaw.json` (no
    // host paths exposed) without failing the whole config load. `typeclaw
    // init` omits this field so users don't see noise for the empty case.
    mounts: z.array(mountSchema).default([]),
    plugins: z.array(z.string().min(1)).default([]),
    channels: channelsSchema,
    portForward: portForwardSchema,
  })
  .catchall(z.unknown())

export type Config = z.infer<typeof configSchema>

export function resolveModel(ref: KnownModelRef): Model<'openai-completions'> {
  // Model IDs can contain '/', so split only on the first separator.
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash) as KnownProviderId
  const modelId = ref.slice(slash + 1)
  return KNOWN_PROVIDERS[providerId].models[modelId as never]
}

// Resolves a mount's `path` field to an absolute host path, mirroring shell
// expansion rules: `~`/`~/...` → home dir, relative → resolved against `cwd`,
// absolute → unchanged. Single source of truth so validation and Docker arg
// building agree on the resolved path.
export function expandMountPath(input: string, cwd: string): string {
  if (input === '~' || input.startsWith('~/')) {
    return join(homedir(), input.slice(1))
  }
  return isAbsolute(input) ? input : resolve(cwd, input)
}

// Loaded eagerly from process.cwd()/typeclaw.json at module-import time so
// citty arg defaults (e.g. config.port in src/cli/*.ts) see real values, not
// hardcoded fallbacks. Missing file → schema defaults; malformed file → throw,
// which surfaces during CLI startup instead of silently reverting to defaults
// and confusing the user.
//
// `config` is a module-import-time snapshot. Container-stage code that must
// observe `typeclaw run` reloads should call `getConfig()` instead, which
// returns the current swapped-in value. Host-stage CLI processes are
// short-lived, so they keep using `config` directly.
export const config: Config = loadConfigSync(process.cwd())

let current: Config = config

export function getConfig(): Config {
  return current
}

// Test-only: restore the live pointer to the module-import-time snapshot. Lets
// reload-aware tests run without leaking a swapped pointer into other test
// files that still mutate the eager `config` export directly.
export function __resetConfigForTesting(): void {
  current = config
}

export type ConfigChange = {
  path: string
  before: unknown
  after: unknown
}

export type ConfigReloadDiff = {
  applied: ConfigChange[]
  restartRequired: ConfigChange[]
  ignored: ConfigChange[]
}

// Reloads typeclaw.json from disk and atomically swaps the live config pointer
// on success. Throws (and leaves `current` untouched) when the file is
// malformed or schema-invalid — callers translate that into a `Reloadable`
// failure result.
export function reloadConfig(cwd: string): ConfigReloadDiff {
  const next = loadConfigSync(cwd)
  const diff = diffConfig(current, next)
  current = next
  return diff
}

// Field classification. The fence is intentional: only fields that are read
// fresh on each session/subagent/cron-reload land in `applied`. Boot-only
// fields (port, mounts, container/server bind) are reported as
// `restartRequired` so the user knows the reload landed but the change won't
// take effect until restart.
export type FieldEffect = 'applied' | 'restart-required' | 'ignored'

export const FIELD_EFFECTS: Record<string, FieldEffect> = {
  $schema: 'ignored',
  model: 'applied',
  port: 'restart-required',
  mounts: 'restart-required',
  plugins: 'restart-required',
  channels: 'applied',
  portForward: 'restart-required',
}

// Stable JSON for value comparison. Fields are small JSON-shaped objects, so
// JSON.stringify with sorted keys is sufficient and avoids a deep-equal dep.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

function diffConfig(before: Config, after: Config): ConfigReloadDiff {
  const diff: ConfigReloadDiff = { applied: [], restartRequired: [], ignored: [] }
  const keys = new Set<string>(Object.keys(FIELD_EFFECTS))

  for (const path of keys) {
    const b = readPath(before, path)
    const a = readPath(after, path)
    if (stableStringify(b) === stableStringify(a)) continue

    const change: ConfigChange = { path, before: b, after: a }
    const effect = FIELD_EFFECTS[path] ?? 'applied'
    if (effect === 'applied') diff.applied.push(change)
    else if (effect === 'restart-required') diff.restartRequired.push(change)
    else diff.ignored.push(change)
  }

  return diff
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// Plugin configs live at the top level of typeclaw.json keyed by plugin name
// (e.g. "standup-log": { ... }). They are preserved by configSchema.catchall(z.unknown())
// because the schema does not predeclare these keys. This helper returns the
// raw map of unknown values keyed by plugin name; the plugin loader re-validates
// each block against its plugin's `configSchema`.
export function extractPluginConfigs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const known = new Set(['$schema', 'port', 'model', 'mounts', 'plugins', 'channels', 'portForward'])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) result[key] = value
  }
  return result
}

export function loadPluginConfigsSync(cwd: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return {}
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  return extractPluginConfigs(json)
}

export function loadConfigSync(cwd: string): Config {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return configSchema.parse({})
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${detail}`)
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${formatZodError(result.error)}`)
  }
  return result.data
}

export type ValidateConfigResult = { ok: true } | { ok: false; reason: string }

// Missing file → ok (matches `loadMounts` in src/container/up.ts; `isInitialized`
// is the dedicated check for "not initialized"). Present but invalid → fail, so
// `restart` doesn't stop the container before discovering the config is broken.
//
// Mount accessibility is checked here (after schema parse succeeds) so every
// caller — `typeclaw start`, `restart`, `reload`, hostd's restart RPC — fails
// fast with a clear, mount-named error instead of letting Docker surface a
// confusing path-sharing error (or, on some Linux setups, silently bind-mount
// an empty auto-created directory). First-failure reporting matches the
// schema-error path's shape; users fix one and re-run.
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

  for (const mount of result.data.mounts) {
    const check = validateMount(mount, cwd)
    if (!check.ok) return check
  }

  return { ok: true }
}

// Verifies a mount's host path: exists, is a directory, is readable, and is
// writable when not declared `readOnly`. Symlinks are followed (statSync's
// default) so a broken symlink reads as "does not exist". Permission checks
// are skipped when running as root (uid 0) — euidaccess returns success
// regardless, so the test would be vacuous and inconsistent with non-root.
export function validateMount(mount: Mount, cwd: string): ValidateConfigResult {
  const resolved = expandMountPath(mount.path, cwd)
  const label = `mount "${mount.name}"`

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, reason: `${label}: path ${resolved} does not exist` }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${label}: cannot stat ${resolved}: ${detail}` }
  }

  if (!stats.isDirectory()) {
    return { ok: false, reason: `${label}: path ${resolved} is not a directory` }
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (isRoot) return { ok: true }

  try {
    accessSync(resolved, fsConstants.R_OK)
  } catch {
    return { ok: false, reason: `${label}: path ${resolved} is not readable` }
  }

  if (!mount.readOnly) {
    try {
      accessSync(resolved, fsConstants.W_OK)
    } catch {
      return {
        ok: false,
        reason: `${label}: path ${resolved} is not writable (declare readOnly: true if read-only access is intended)`,
      }
    }
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
