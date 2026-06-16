import { mkdir } from 'node:fs/promises'
import { posix } from 'node:path'

// Container-only code over the POSIX `/tmp`; pinned to `path.posix` so the test
// suite produces the same backing paths on a win32 runner (default `node:path`
// would yield `\tmp\…` and diverge from the Linux runtime).
const { isAbsolute, join, relative, resolve } = posix

// Per-session scratch lives on the REAL container /tmp, namespaced by session id.
// It sits OUTSIDE the agent folder on purpose: the agent folder's `sessions/` is
// force-committed by typeclaw, and scratch must never be committed. The real
// /tmp is ephemeral (dies with the container) and already the natural home for
// throwaway files, so a per-session subdir of it gives `/tmp` semantics without
// either sharing the whole container /tmp into a sandboxed role or persisting
// anything into the project surface.
export const SESSION_TMP_ROOT = '/tmp/typeclaw-session'

export function sessionTmpDir(sessionId: string): string {
  return join(SESSION_TMP_ROOT, sessionId)
}

export async function ensureSessionTmpDir(sessionId: string): Promise<string> {
  const dir = sessionTmpDir(sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function isUnderTmp(agentDir: string, rawPath: string): boolean {
  const resolved = resolve(agentDir, rawPath)
  return resolved === '/tmp' || isInside('/tmp', resolved)
}

// Maps a model-facing /tmp path to its per-session backing path. Returns
// undefined when the path is not under /tmp (caller leaves it untouched). The
// model keeps writing/reading `/tmp/foo`; only the on-disk target moves to
// `<SESSION_TMP_ROOT>/<sid>/foo`, which is the same dir bwrap binds over `/tmp`
// for the sandboxed bash that reads it back.
export function mapVirtualTmpPath(agentDir: string, sessionId: string, rawPath: string): string | undefined {
  const resolved = resolve(agentDir, rawPath)
  if (resolved !== '/tmp' && !isInside('/tmp', resolved)) return undefined
  const rel = relative('/tmp', resolved)
  return rel === '' ? sessionTmpDir(sessionId) : join(sessionTmpDir(sessionId), rel)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
