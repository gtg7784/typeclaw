import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// A GIT_ASKPASS helper git invokes for username/password prompts. The token
// rides in TYPECLAW_GIT_TOKEN (env, via the bash env overlay), NEVER in argv or
// git config — so it cannot leak through process listings, logs, or .git/config.
// The script contents are constant and secret-free; only the env value is secret.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$TYPECLAW_GIT_TOKEN" ;;
esac
`

// /usr is --ro-bind mounted into the per-tool bwrap sandbox (src/sandbox/build.ts),
// so a helper here is readable by sandboxed bash; the per-session /tmp bind is not
// a stable path. TYPECLAW_GIT_ASKPASS_PATH overrides it for tests/CI, which
// cannot write under /usr.
const DEFAULT_ASKPASS_PATH = '/usr/local/bin/typeclaw-git-askpass'

function defaultPath(): string {
  const override = process.env.TYPECLAW_GIT_ASKPASS_PATH
  return override !== undefined && override !== '' ? override : DEFAULT_ASKPASS_PATH
}

let ensurePromise: Promise<string> | null = null

export function resetGitAskPassHelperForTests(): void {
  ensurePromise = null
}

// Writes the helper once per process (idempotent, race-safe via the shared
// promise) and returns its absolute path. Write-then-rename so a concurrent
// reader never sees a partial file.
export function ensureGitAskPassHelper(path: string = defaultPath()): Promise<string> {
  if (ensurePromise !== null) return ensurePromise
  ensurePromise = (async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.typeclaw-git-askpass.${process.pid}.tmp`)
    await writeFile(tmp, ASKPASS_SCRIPT, { mode: 0o755 })
    await chmod(tmp, 0o755)
    await rename(tmp, path)
    return path
  })().catch((err) => {
    ensurePromise = null
    throw err
  })
  return ensurePromise
}
