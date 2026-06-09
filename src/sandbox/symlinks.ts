import { posix } from 'node:path'

import type { SandboxSymlinkOp } from './policy'

const { isAbsolute, join, normalize } = posix

export type SandboxSymlinkSpec = {
  from: string
  to: string
}

// Resolves config `sandbox.symlinks` into the in-jail `--symlink` ops the bwrap
// builder consumes. `from` is the symlink LOCATION: a `~/`-prefixed `from` is
// expanded against the SANDBOX HOME (`/tmp`, where the per-session tmp dir is
// bound), NOT the container's real `/root` — inside the jail a CLI reading
// `$HOME/.foo` looks under `/tmp`, so the symlink must live there. An absolute
// `from` is used verbatim. `to` is resolved to the absolute /agent path the
// symlink points at. Container paths are always POSIX, so this uses posix path
// ops regardless of the dev-stage host OS.
export function resolveSandboxSymlinks(
  agentDir: string,
  specs: readonly SandboxSymlinkSpec[],
  sandboxHome: string,
): SandboxSymlinkOp[] {
  return specs.map((spec) => ({
    target: join(agentDir, spec.to),
    dest: resolveSymlinkDest(spec.from, sandboxHome),
  }))
}

function resolveSymlinkDest(from: string, home: string): string {
  if (from.startsWith('~/')) return join(home, from.slice(2))
  return isAbsolute(from) ? normalize(from) : join(home, from)
}
