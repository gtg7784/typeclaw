import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pkg from '../../package.json' with { type: 'json' }

export const GHCR_BASE_IMAGE_REPO = 'ghcr.io/typeclaw/typeclaw-base'

export const CLI_VERSION: string = pkg.version

const __dirname = dirname(fileURLToPath(import.meta.url))

// Self-locate the CLI's source root by walking up from this file until we hit
// the package.json that lists "typeclaw" as its name. This lets the dev-mode
// detector below distinguish a real install (typeclaw shipped via npm into
// the agent's node_modules) from a file:-spec install (typeclaw symlinked
// from a local checkout). The latter must NOT pin a versioned base image
// because the version in the dev tree is the next-to-be-released one and
// the matching :X.Y.Z tag does not exist on GHCR yet.
async function findCliRoot(): Promise<string | null> {
  let dir = __dirname
  while (true) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw) as { name?: string }
      if (parsed.name === 'typeclaw') return dir
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// The CLI's own source root resolved at module load. Captures whichever
// package.json shipped alongside this src/ — node_modules/typeclaw for users,
// the repo root for typeclaw contributors. Memoized so we don't re-walk on
// every call.
const cliRoot = await findCliRoot()

// True when this looks like a real install of typeclaw — i.e. the agent
// folder's package.json declares typeclaw with a registry-style dep spec
// ("^0.1.1", "0.1.1", "latest", etc.). Missing package.json, missing
// typeclaw dep, or a "file:" / "link:" spec all read as not-installed:
// either the test/scaffolding doesn't model an installed CLI yet, or
// typeclaw is symlinked from a local checkout whose version is the next-
// to-release one (not yet on GHCR). Pinning the versioned base image only
// when we have positive evidence of a real install avoids the "docker
// pull 404 on every start" failure mode in dev and tests.
async function isInstalledAgent(agentDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(agentDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = parsed.dependencies?.typeclaw
    if (typeof spec !== 'string' || spec.length === 0) return false
    return !spec.startsWith('file:') && !spec.startsWith('link:')
  } catch {
    return false
  }
}

// Returns the base image version to pin in the per-agent Dockerfile, or
// `null` when the per-agent Dockerfile should fall back to inlining the
// heavy stack (dev mode, missing/incomplete agent package.json, or CLI
// source not locatable). Callers should pass the result directly to
// `buildDockerfile(config, { baseImageVersion })`.
export async function resolveBaseImageVersion(agentDir: string): Promise<string | null> {
  if (cliRoot === null) return null
  if (!(await isInstalledAgent(agentDir))) return null
  return CLI_VERSION
}
