import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { decodeCodexAccessTokenExpiryMs, emitCodexAuthJson, isDecodableJwt } from './codex-auth-json'
import type { ProviderCredential, Providers } from './schema'
import { SecretsBackend } from './storage'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export type ExportCodexAuthFileResult =
  | { action: 'skipped'; reason: SkipReason }
  | { action: 'wrote'; path: string }
  | { action: 'failed'; reason: string }

export type SkipReason =
  | 'codex-cli-disabled'
  | 'no-openai-codex-credential'
  | 'credential-not-oauth'
  | 'on-disk-is-fresher'

export type ExportCodexAuthFileOptions = {
  codexCliEnabled: boolean
  providers: Providers
  homeDir?: string
  now?: () => number
  log?: (message: string) => void
}

// Writes typeclaw's openai-codex OAuth credential to $HOME/.codex/auth.json
// when it's safe to do so. The Dockerfile entrypoint shim symlinks
// $HOME/.codex/auth.json to /agent/.typeclaw/home/.codex/auth.json on every
// boot, so the write follows the symlink and lands on the persistent
// host-side path — that's the stable contract from src/init/dockerfile.ts
// "link_persistent_home_files" and we MUST use it instead of writing to
// /agent/.typeclaw/home/ directly.
//
// Three guards, cheapest first. The first two return without ever touching
// the filesystem, which keeps the 90% case (users who don't enable Codex
// CLI) at zero overhead on every container start.
export function exportCodexAuthFileIfApplicable(options: ExportCodexAuthFileOptions): ExportCodexAuthFileResult {
  if (!options.codexCliEnabled) return { action: 'skipped', reason: 'codex-cli-disabled' }

  const credential = options.providers['openai-codex']
  if (credential === undefined) return { action: 'skipped', reason: 'no-openai-codex-credential' }
  if (credential.type !== 'oauth') return { action: 'skipped', reason: 'credential-not-oauth' }

  const targetPath = join(options.homeDir ?? homedir(), '.codex', 'auth.json')

  try {
    if (!shouldOverwrite(targetPath, credential, options.now ?? Date.now)) {
      return { action: 'skipped', reason: 'on-disk-is-fresher' }
    }
    const contents = emitCodexAuthJson(credential)
    writeAtomic(targetPath, contents)
    return { action: 'wrote', path: targetPath }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`exportCodexAuthFile: ${reason}`)
    return { action: 'failed', reason }
  }
}

// Newer-wins: skip the write unless typeclaw's stored credential is
// strictly fresher than the on-disk JWT. Codex CLI rotates tokens
// in-place (it rewrites auth.json with a refreshed access_token whose
// JWT exp is later), so on a restart the file may legitimately be ahead
// of secrets.json. We must not clobber that.
//
// Ties skip: when expiries match, there's nothing to gain from a write,
// and avoiding the I/O keeps the steady state at zero churn after the
// first boot. The only writes we ever do are first-write (B1), recovery
// (B6), or refresh-from-typeclaw-side (B3).
//
// On any error reading or parsing the on-disk file (missing, corrupt JSON,
// missing JWT, undecodable exp), we return true. That's the "we have a
// valid credential, the file is unusable, replace it" fallback case (B1
// and B6 in the design doc).
//
// A file missing a usable `id_token` is unusable too, regardless of how
// fresh its access token is: codex rejects the whole auth.json with
// `missing field id_token` before any model call. This guard runs BEFORE
// the newer-wins expiry compare so a pre-fix TypeClaw-emitted file (valid,
// possibly fresher access token, but no id_token) is always rewritten —
// the path that self-heals already-broken agents on restart.
function shouldOverwrite(
  targetPath: string,
  credential: ProviderCredential & { expires?: unknown; access?: unknown },
  now: () => number,
): boolean {
  let raw: string
  try {
    raw = readFileSync(targetPath, 'utf8')
  } catch {
    return true
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true
  }

  if (!onDiskHasUsableIdToken(parsed)) return true

  const onDiskAccess = readOnDiskAccessToken(parsed)
  if (onDiskAccess === null) return true

  const onDiskExpiry = decodeCodexAccessTokenExpiryMs(onDiskAccess)
  if (onDiskExpiry === null) return true

  const credentialExpiry = readCredentialExpiry(credential, now)
  return credentialExpiry > onDiskExpiry
}

function readOnDiskAccessToken(parsed: unknown): string | null {
  return readOnDiskToken(parsed, 'access_token')
}

// codex parses `tokens.id_token` as a JWT, so a value that is absent, empty,
// or not a decodable JWT is unusable — codex rejects the whole auth.json on
// load. Validate decodability (not just presence) so a file with a non-empty
// but malformed id_token, even alongside a fresh access token, is treated as
// stale and rewritten rather than preserved by the newer-wins compare.
function onDiskHasUsableIdToken(parsed: unknown): boolean {
  const idToken = readOnDiskToken(parsed, 'id_token')
  return idToken !== null && isDecodableJwt(idToken)
}

function readOnDiskToken(parsed: unknown, field: 'access_token' | 'id_token'): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const tokens = (parsed as Record<string, unknown>)['tokens']
  if (typeof tokens !== 'object' || tokens === null) return null
  const value = (tokens as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Resolution order for the credential's expiry:
//   1. The `expires` field pi-ai writes (absolute ms epoch).
//   2. The JWT `exp` claim decoded from `access`.
//   3. Now — guarantees we still write on first boot when the credential
//      lacks both, rather than silently skipping forever.
function readCredentialExpiry(credential: { expires?: unknown; access?: unknown }, now: () => number): number {
  if (typeof credential.expires === 'number' && Number.isFinite(credential.expires)) {
    return credential.expires
  }
  if (typeof credential.access === 'string') {
    const fromJwt = decodeCodexAccessTokenExpiryMs(credential.access)
    if (fromJwt !== null) return fromJwt
  }
  return now()
}

// Atomic temp-then-rename, mirroring src/secrets/storage.ts's
// writeEnvelopeAtomic. The directory is created with 0700 and the file
// with 0600 because $HOME/.codex/auth.json holds a long-lived refresh
// token — leaking it via lax permissions defeats the whole point of
// running typeclaw on a multi-user host. The 0600 chmod after rename is
// belt-and-suspenders: writeFileSync's `mode` is applied at create time,
// but umask can mask it down on some filesystems.
//
// Symlink preservation: the entrypoint shim
// (src/init/dockerfile.ts link_persistent_home_files) installs
// $HOME/.codex/auth.json as a symlink to
// /agent/.typeclaw/home/.codex/auth.json on every boot. POSIX rename(2)
// replaces the directory entry at the destination atomically — it does
// NOT follow symlinks — so a naive `renameSync(tmp, $HOME/.codex/auth.json)`
// would replace the symlink with a regular file, leaving the persistent
// path empty. Next boot the shim recreates the symlink (force-removing
// our file), the persistent path is still empty, and Codex's in-place
// token refresh is silently lost on every restart.
//
// Fix: resolve the symlink target with readlinkSync and rename against
// the real path so the symlink itself is preserved. The temp file MUST
// live alongside the real target (same filesystem) because renameSync
// across filesystems fails with EXDEV — $HOME is the container's
// overlayfs, but the symlink target is a bind-mounted host path.
function writeAtomic(targetPath: string, contents: string): void {
  const realTarget = resolveSymlinkTarget(targetPath)
  const dir = dirname(realTarget)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const tmp = `${realTarget}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: FILE_MODE })
  try {
    renameSync(tmp, realTarget)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup of the temp file when rename fails
    }
    throw err
  }
  // statSync + chmodSync rather than unconditional chmod so a 0644 file
  // installed by something else stays visible in tests (we WANT to overwrite
  // permissions when we own the file).
  try {
    statSync(realTarget)
    chmodSync(realTarget, FILE_MODE)
  } catch {
    // ignore — file vanished between rename and chmod is benign
  }
}

// Returns the absolute path renameSync should target. When `path` is a
// symlink (production: $HOME/.codex/auth.json -> /agent/.typeclaw/home/...),
// returns the resolved absolute target so we write through the link
// instead of replacing it. Otherwise (tests, or first boot before the
// shim installs the symlink — though the shim runs before the agent in
// production), returns the path unchanged.
//
// readlinkSync throws EINVAL when the path exists but isn't a symlink,
// and ENOENT when nothing is there. Either case → write to the original
// path; the parent-dir mkdir + atomic rename handle the rest. We don't
// distinguish errno because both have the same fallback.
function resolveSymlinkTarget(path: string): string {
  let link: string
  try {
    link = readlinkSync(path)
  } catch {
    return path
  }
  return isAbsolute(link) ? link : resolve(dirname(path), link)
}

export type ExportCodexAuthFileForAgentOptions = {
  agentDir: string
  codexCliEnabled: boolean
  homeDir?: string
  log?: (message: string) => void
}

// Boot-time convenience wrapper for src/run/index.ts. Mirrors
// hydrateChannelEnvFromSecrets's contract: takes agentDir, never throws,
// returns a result the caller can ignore. Secrets-file read failures are
// caught and surfaced as a 'failed' result so the agent boot is not blocked
// by a missing or malformed secrets.json — same non-fatal policy hydrate
// uses on the channels slice.
export function exportCodexAuthFileForAgent(options: ExportCodexAuthFileForAgentOptions): ExportCodexAuthFileResult {
  if (!options.codexCliEnabled) return { action: 'skipped', reason: 'codex-cli-disabled' }
  let providers: Providers
  try {
    providers = new SecretsBackend(join(options.agentDir, 'secrets.json')).tryReadProvidersSync()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`exportCodexAuthFile: ${reason}`)
    return { action: 'failed', reason }
  }
  return exportCodexAuthFileIfApplicable({
    codexCliEnabled: options.codexCliEnabled,
    providers,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  })
}
