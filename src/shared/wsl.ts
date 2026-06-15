import { existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'

// Detection of WSL (Windows Subsystem for Linux) and Windows-drive mounts.
//
// Why this matters for typeclaw: inside WSL the kernel is real Linux, so the
// host stage runs unchanged — EXCEPT when files live on a Windows-drive mount
// (DrvFs on WSL1, 9p on WSL2, e.g. `/mnt/c/...`). On those mounts POSIX
// permissions are NOT enforced: `chmod 0o600` silently succeeds but leaves the
// file world-readable. typeclaw stores encryption keys and API tokens with
// mode 0600 (src/secrets/*, src/hostd/paths.ts), so a secrets file on `/mnt/c`
// loses its confidentiality guarantee. The doctor surfaces this as a warning.

export type WslVersion = 1 | 2

export type WslInfo = {
  isWsl: boolean
  // null when not WSL, or WSL but the version can't be determined (e.g. a
  // custom kernel detected only via the binfmt/`/run/WSL` artifacts).
  version: WslVersion | null
}

// Injectable so the pure detection logic is unit-testable without a real
// `/proc` or `/etc/wsl.conf`; production uses the real-filesystem defaults.
export type WslProbes = {
  platform: NodeJS.Platform
  kernelRelease: () => string
  readFile: (path: string) => string | null
  fileExists: (path: string) => boolean
  env: NodeJS.ProcessEnv
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const defaultProbes: WslProbes = {
  platform: process.platform,
  kernelRelease: release,
  readFile: safeReadFile,
  fileExists: existsSync,
  env: process.env,
}

// Mirrors the is-wsl@3 cascade: os.release() → /proc/version → WSL runtime
// artifacts. Matching is case-insensitive because WSL1 stamps `Microsoft`
// (capital M) and WSL2 stamps `microsoft` (lowercase) into the kernel strings.
// A user-compiled WSL2 kernel can omit the string entirely, which is why the
// binfmt/`/run/WSL` artifacts are the final fallback.
export function detectWslWith(probes: WslProbes): WslInfo {
  if (probes.platform !== 'linux') return { isWsl: false, version: null }

  const kernelRelease = probes.kernelRelease().toLowerCase()
  const procVersion = (probes.readFile('/proc/version') ?? '').toLowerCase()

  const kernelSaysMicrosoft = kernelRelease.includes('microsoft')
  const procSaysMicrosoft = procVersion.includes('microsoft')
  const hasArtifacts = probes.fileExists('/proc/sys/fs/binfmt_misc/WSLInterop') || probes.fileExists('/run/WSL')

  if (!kernelSaysMicrosoft && !procSaysMicrosoft && !hasArtifacts) {
    return { isWsl: false, version: null }
  }

  return { isWsl: true, version: resolveWslVersion({ kernelRelease, procVersion, env: probes.env }) }
}

// WSL_INTEROP is present only under WSL2 (Microsoft's own recommendation in
// microsoft/WSL#4555). It can be stripped by `sudo`, so the kernel-string
// heuristics back it up: WSL2 kernels are `*-microsoft-standard*` / contain
// `wsl2`; WSL1 kernels are the older `*-Microsoft` form without "standard".
function resolveWslVersion(args: {
  kernelRelease: string
  procVersion: string
  env: NodeJS.ProcessEnv
}): WslVersion | null {
  if (args.env.WSL_INTEROP !== undefined && args.env.WSL_INTEROP !== '') return 2

  const haystack = `${args.kernelRelease} ${args.procVersion}`
  if (haystack.includes('wsl2') || haystack.includes('microsoft-standard')) return 2

  // Older WSL1 kernels say `microsoft` but never `standard`/`wsl2`. If we only
  // know it's WSL from the kernel/proc string (not the artifacts), call it v1.
  if (args.kernelRelease.includes('microsoft') || args.procVersion.includes('microsoft')) return 1

  return null
}

export function detectWsl(): WslInfo {
  return detectWslWith(defaultProbes)
}

// The WSL automount root defaults to `/mnt/` but can be remapped via
// `/etc/wsl.conf` ([automount] root = ...). Returns the configured root with a
// guaranteed trailing slash, or `/mnt/` when unset/unreadable.
export function readAutomountRootWith(probes: Pick<WslProbes, 'readFile'>): string {
  const conf = probes.readFile('/etc/wsl.conf')
  const parsed = conf === null ? null : parseAutomountRoot(conf)
  const root = parsed ?? '/mnt/'
  return root.endsWith('/') ? root : `${root}/`
}

function parseAutomountRoot(content: string): string | null {
  let inAutomountSection = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(?<name>[^\]]+)\]$/.exec(line)
    if (section) {
      inAutomountSection = section.groups?.name?.trim().toLowerCase() === 'automount'
      continue
    }
    if (!inAutomountSection) continue
    const match = /^root\s*=\s*(?<value>"[^"]*"|'[^']*'|[^#;]*)/.exec(line)
    const raw = match?.groups?.value
    if (raw === undefined) continue
    const value = raw.trim().replace(/^["']|["']$/g, '')
    if (value.length > 0) return value
  }
  return null
}

// True when `path` lives under the WSL Windows-drive automount (e.g.
// `/mnt/c/...`), where Unix permissions are not enforced. The drive component
// must be a single ASCII letter so `/mnt/wsl/...` (WSLg, not a Windows drive)
// is correctly excluded.
export function isWindowsDriveMountWith(path: string, probes: Pick<WslProbes, 'readFile'>): boolean {
  const root = readAutomountRootWith(probes)
  if (!path.startsWith(root)) return false
  const rest = path.slice(root.length)
  return /^[A-Za-z](?:\/|$)/.test(rest)
}

export function isWindowsDriveMount(path: string): boolean {
  return isWindowsDriveMountWith(path, defaultProbes)
}
