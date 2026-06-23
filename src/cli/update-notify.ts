import { CLI_VERSION, isInstalledCli } from '@/init/cli-version'
import {
  isCacheFresh,
  readVersionCache,
  renderUpdateNotice,
  resolveSkipReason,
  type VersionCache,
} from '@/update/check'

import { shouldConsiderUpdateNotice, UPDATE_CHECK_COMMAND } from './update-suppression'

export { shouldConsiderUpdateNotice }

export type UpdateAction = { notice: string | null; refresh: boolean }

// Pure decision, kept config-free (takes `configEnabled` as a param) so it is
// unit-testable without spawning or loading config. Two invariants the reviews
// pinned: a skipped check suppresses BOTH the notice and the refresh; and a
// FRESH cache (success or failure-only) suppresses the refresh so the parent
// stops forking a check child on every invocation while the throttle holds.
export function decideUpdateAction(opts: {
  current: string
  isInstalled: boolean
  configEnabled: boolean
  env: Record<string, string | undefined>
  cache: VersionCache | null
  now: number
}): UpdateAction {
  const skip = resolveSkipReason({
    current: opts.current,
    isInstalled: opts.isInstalled,
    configEnabled: opts.configEnabled,
    env: opts.env,
  })
  if (skip !== null) return { notice: null, refresh: false }
  return {
    notice: renderUpdateNotice({ current: opts.current, cache: opts.cache }),
    refresh: !isCacheFresh(opts.cache, opts.now),
  }
}

// The host-stage entry hook. Fail-open: a thrown error here must never disrupt
// the command the user actually ran, so the whole body is best-effort. Order is
// load-bearing: the dependency-free skip (env / dev / non-release) runs BEFORE
// @/config is ever imported, so a suppressed command (CI / opt-out) never pays
// the eager config load that would emit malformed-typeclaw.json warnings.
export async function maybeNotifyUpdate(commandName: string | undefined): Promise<void> {
  try {
    if (!shouldConsiderUpdateNotice(commandName)) return

    const { resolveDependencyFreeSkip } = await import('@/update/check')
    if (resolveDependencyFreeSkip({ current: CLI_VERSION, isInstalled: isInstalledCli(), env: process.env }) !== null) {
      return
    }

    const { config } = await import('@/config')
    const cache = await readVersionCache()
    const action = decideUpdateAction({
      current: CLI_VERSION,
      isInstalled: isInstalledCli(),
      configEnabled: config.updateCheck.enabled,
      env: process.env,
      cache,
      now: Date.now(),
    })

    if (action.notice !== null) process.stderr.write(`${action.notice}\n`)
    if (action.refresh) spawnBackgroundRefresh()
  } catch {}
}

// Detached `typeclaw _update-check` child: fully unref'd so the parent process
// exits immediately regardless of the network call's fate (the user's hard rule
// — the command is 10000x more important than the check). stdio is ignored so
// the child can't write into the parent's terminal.
function spawnBackgroundRefresh(): void {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return
  const cliEntry = process.argv[1]
  if (cliEntry === undefined) return
  try {
    const proc = bun.spawn({
      cmd: [process.execPath, cliEntry, UPDATE_CHECK_COMMAND],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env },
    })
    proc.unref()
  } catch {}
}
