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

import { decodeClaudeAccessTokenExpiryMs, emitClaudeCredentialsJson } from './claude-credentials-json'
import type { ProviderCredential, Providers } from './schema'
import { SecretsBackend } from './storage'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
export const CLAUDE_CREDENTIALS_FILE_NAME = '.credentials.json'
export const CLAUDE_DEFAULT_CONFIG_DIR_NAME = '.claude'
export const CLAUDE_CREDENTIALS_RELATIVE_PATH = join(CLAUDE_DEFAULT_CONFIG_DIR_NAME, CLAUDE_CREDENTIALS_FILE_NAME)

export type ExportClaudeCredentialsFileResult =
  | { action: 'skipped'; reason: SkipReason }
  | { action: 'wrote'; path: string }
  | { action: 'failed'; reason: string }

export type SkipReason =
  | 'claude-code-disabled'
  | 'no-anthropic-credential'
  | 'credential-not-oauth'
  | 'on-disk-is-fresher'

export type ExportClaudeCredentialsFileOptions = {
  claudeCodeEnabled: boolean
  providers: Providers
  homeDir?: string
  configDir?: string
  now?: () => number
  log?: (message: string) => void
}

// Writes typeclaw's anthropic OAuth credential to
// $CLAUDE_CONFIG_DIR/.credentials.json (or $HOME/.claude/.credentials.json
// by default) when it's safe to do so. The Dockerfile entrypoint shim
// symlinks the same resolved credentials path to
// /agent/.typeclaw/home/.claude/.credentials.json on every boot, so the
// write follows the symlink and lands on the persistent host-side path —
// same contract as exportCodexAuthFile.
//
// Three guards, cheapest first. The first two return without ever touching
// the filesystem, which keeps the 90% case (users who don't enable
// Claude Code) at zero overhead on every container start.
export function exportClaudeCredentialsFileIfApplicable(
  options: ExportClaudeCredentialsFileOptions,
): ExportClaudeCredentialsFileResult {
  if (!options.claudeCodeEnabled) return { action: 'skipped', reason: 'claude-code-disabled' }

  const credential = options.providers['anthropic']
  if (credential === undefined) return { action: 'skipped', reason: 'no-anthropic-credential' }
  if (credential.type !== 'oauth') return { action: 'skipped', reason: 'credential-not-oauth' }

  const targetPath = resolveClaudeCredentialsPath({
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
  })

  try {
    const existing = readExisting(targetPath)
    if (!shouldOverwrite(existing, credential, options.now ?? Date.now)) {
      return { action: 'skipped', reason: 'on-disk-is-fresher' }
    }
    const mcpOAuthOpt = existing?.mcpOAuth !== undefined ? { preserveMcpOAuth: existing.mcpOAuth } : {}
    const contents = emitClaudeCredentialsJson(credential, mcpOAuthOpt)
    writeAtomic(targetPath, contents)
    return { action: 'wrote', path: targetPath }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`exportClaudeCredentialsFile: ${reason}`)
    return { action: 'failed', reason }
  }
}

type ExistingFile = {
  onDiskAccessToken: string | null
  onDiskExpiresAt: number | null
  mcpOAuth: unknown
}

// Read once, parse once. Returns null when the file is missing OR
// unparseable. Returning null short-circuits both branches of the
// overwrite decision (the no-disk-file recovery path) AND drops any
// non-recoverable mcpOAuth state — but if the file is unparseable
// there's nothing to recover anyway. When parsing succeeds, we hand
// back the access token (for the newer-wins compare) and the raw
// mcpOAuth block (for read-merge-write preservation).
function readExisting(targetPath: string): ExistingFile | null {
  let raw: string
  try {
    raw = readFileSync(targetPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const claudeBlock = obj['claudeAiOauth']
  let onDiskAccessToken: string | null = null
  let onDiskExpiresAt: number | null = null
  if (typeof claudeBlock === 'object' && claudeBlock !== null) {
    const claudeObj = claudeBlock as Record<string, unknown>
    const access = claudeObj['accessToken']
    if (typeof access === 'string' && access.length > 0) onDiskAccessToken = access
    const expiresAt = claudeObj['expiresAt']
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
      onDiskExpiresAt = expiresAt
    }
  }
  return { onDiskAccessToken, onDiskExpiresAt, mcpOAuth: obj['mcpOAuth'] }
}

// Newer-wins: skip the write unless typeclaw's stored credential is
// strictly fresher than the on-disk expiry. Claude Code rotates tokens
// in-place (issue #53063 in anthropics/claude-code confirms it rewrites
// .credentials.json with a fresher accessToken/refreshToken/expiresAt
// on every successful refresh), so on a restart the file may legitimately
// be ahead of secrets.json. We must not clobber that.
//
// Ties skip: when expiries match there's nothing to gain from a write,
// and avoiding the I/O keeps the steady state at zero churn.
//
// existing === null OR existing.onDiskAccessToken === null OR expiry
// undecodable from both expiresAt and JWT → return true. That's the "we
// have a valid credential, the file is unusable, replace it" recovery case.
function shouldOverwrite(
  existing: ExistingFile | null,
  credential: ProviderCredential & { expires?: unknown; access?: unknown },
  now: () => number,
): boolean {
  if (existing === null) return true
  if (existing.onDiskAccessToken === null) return true
  const onDiskExpiry = readOnDiskExpiry(existing)
  if (onDiskExpiry === null) return true
  const credentialExpiry = readCredentialExpiry(credential, now)
  return credentialExpiry > onDiskExpiry
}

function readOnDiskExpiry(existing: ExistingFile): number | null {
  if (existing.onDiskExpiresAt !== null) return existing.onDiskExpiresAt
  if (existing.onDiskAccessToken === null) return null
  return decodeClaudeAccessTokenExpiryMs(existing.onDiskAccessToken)
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
    const fromJwt = decodeClaudeAccessTokenExpiryMs(credential.access)
    if (fromJwt !== null) return fromJwt
  }
  return now()
}

export function resolveClaudeCredentialsPath(options: { homeDir?: string; configDir?: string } = {}): string {
  const configDir = resolveClaudeConfigDir(options.configDir)
  if (configDir !== null) return join(configDir, CLAUDE_CREDENTIALS_FILE_NAME)
  return join(options.homeDir ?? homedir(), CLAUDE_CREDENTIALS_RELATIVE_PATH)
}

function resolveClaudeConfigDir(configDir: string | undefined): string | null {
  const raw = configDir ?? process.env['CLAUDE_CONFIG_DIR']
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

// Atomic temp-then-rename, mirroring export-codex-auth-file.ts's
// writeAtomic. The directory is created with 0700 and the file with 0600
// because the credential carries a long-lived refresh token — leaking it
// via lax permissions defeats the whole point. The 0600 chmod after
// rename is belt-and-suspenders: writeFileSync's `mode` is applied at
// create time, but umask can mask it down on some filesystems.
//
// Symlink preservation: the entrypoint shim will install
// $HOME/.claude/.credentials.json as a symlink to
// /agent/.typeclaw/home/.claude/.credentials.json. POSIX rename(2)
// replaces the directory entry at the destination atomically and does
// NOT follow symlinks, so a naive renameSync against the symlink path
// would replace the symlink with a regular file, leaving the persistent
// path empty and Claude Code's in-place token refresh silently lost on
// every restart. Resolve the symlink target with readlinkSync and rename
// against the real path so the symlink itself is preserved. The temp
// file MUST live alongside the real target (same filesystem) because
// renameSync across filesystems fails with EXDEV.
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
  try {
    statSync(realTarget)
    chmodSync(realTarget, FILE_MODE)
  } catch {
    // ignore — file vanished between rename and chmod is benign
  }
}

// Returns the absolute path renameSync should target. When `path` is a
// symlink (production: $HOME/.claude/.credentials.json -> /agent/...),
// returns the resolved absolute target so we write through the link
// instead of replacing it. Otherwise (tests, or first boot before the
// shim installs the symlink), returns the path unchanged. readlinkSync
// throws EINVAL when the path exists but isn't a symlink and ENOENT
// when nothing is there — both cases fall through to the original path.
function resolveSymlinkTarget(path: string): string {
  let link: string
  try {
    link = readlinkSync(path)
  } catch {
    return path
  }
  return isAbsolute(link) ? link : resolve(dirname(path), link)
}

export type ExportClaudeCredentialsFileForAgentOptions = {
  agentDir: string
  claudeCodeEnabled: boolean
  homeDir?: string
  configDir?: string
  log?: (message: string) => void
}

// Boot-time convenience wrapper for src/run/index.ts. Mirrors
// exportCodexAuthFileForAgent: takes agentDir, never throws, returns a
// result the caller can ignore. Secrets-file read failures are caught
// and surfaced as 'failed' so the agent boot is never blocked by a
// missing or malformed secrets.json.
export function exportClaudeCredentialsFileForAgent(
  options: ExportClaudeCredentialsFileForAgentOptions,
): ExportClaudeCredentialsFileResult {
  if (!options.claudeCodeEnabled) return { action: 'skipped', reason: 'claude-code-disabled' }
  let providers: Providers
  try {
    providers = new SecretsBackend(join(options.agentDir, 'secrets.json')).tryReadProvidersSync()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`exportClaudeCredentialsFile: ${reason}`)
    return { action: 'failed', reason }
  }
  return exportClaudeCredentialsFileIfApplicable({
    claudeCodeEnabled: options.claudeCodeEnabled,
    providers,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  })
}
