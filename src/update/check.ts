import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { c } from '@/cli/ui'
import { UPDATE_CHECK_COMMAND } from '@/cli/update-suppression'
import { homeRoot, versionCachePath } from '@/hostd/paths'

export { UPDATE_CHECK_COMMAND }
const NPM_LATEST_URL = 'https://registry.npmjs.org/typeclaw/latest'
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

export type VersionCache = {
  latest?: string
  checkedAt?: number
  // The throttle marker, distinct from `checkedAt` (last success) on purpose: it
  // advances on every refresh RUN, success or failure, so an npm outage can't
  // make each CLI invocation respawn a check child until the fetch finally wins.
  lastAttemptAt: number
}

// Returns true only for an `X.Y.Z` release version (no pre-release / build
// metadata) — the only shape we can confidently compare and turn into a `Run:
// typeclaw update` nudge. Anything else (dist-tags, ranges, a dev `0.0.0`) is
// treated as "not comparable" upstream.
export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version)
}

// Positive when `a` is newer than `b`, negative when older, 0 when equal.
// Hand-rolled rather than adding the `semver` package for a three-integer
// compare — mirrors src/init/auto-upgrade.ts. Inputs must pass isReleaseVersion.
export function compareReleaseVersions(a: string, b: string): number {
  const av = a.match(RELEASE_VERSION)
  const bv = b.match(RELEASE_VERSION)
  if (av === null || bv === null) return 0
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i])
    if (diff !== 0) return diff
  }
  return 0
}

// The disk-only hot path: parse a cached "latest" version and decide whether to
// render a one-line update notice. Pure — no I/O — so the per-invocation cost is
// just the caller's single cache read. Returns null when there's nothing to say
// (no cache, unparseable, not a release, or already up to date).
export function renderUpdateNotice(opts: { current: string; cache: VersionCache | null }): string | null {
  const { current, cache } = opts
  if (cache?.latest === undefined) return null
  if (!isReleaseVersion(current) || !isReleaseVersion(cache.latest)) return null
  if (compareReleaseVersions(cache.latest, current) <= 0) return null
  return `${c.dim('⚡ Update available:')} ${current} ${c.dim('→')} ${c.green(cache.latest)}  ${c.dim('Run:')} ${c.cyan('typeclaw update')}`
}

export type SkipReason = 'disabled-env' | 'disabled-config' | 'dev-checkout' | 'not-release'
export type DependencyFreeSkipReason = Exclude<SkipReason, 'disabled-config'>

// The skip reasons that need NO config: env opt-out, dev checkout, non-release
// version. Split out so the caller can run these BEFORE importing @/config —
// a suppressed command (CI / TYPECLAW_NO_UPDATE_CHECK) must not pay the eager
// config load, which would emit malformed-typeclaw.json warnings (review).
export function resolveDependencyFreeSkip(opts: {
  current: string
  isInstalled: boolean
  env: Record<string, string | undefined>
}): DependencyFreeSkipReason | null {
  if (isEnvOptOut(opts.env)) return 'disabled-env'
  if (!opts.isInstalled) return 'dev-checkout'
  if (!isReleaseVersion(opts.current)) return 'not-release'
  return null
}

// Full skip matrix including the config opt-out. The config check is folded in
// last so callers that have already cleared the dependency-free reasons only
// reach it after deciding a config read is warranted.
export function resolveSkipReason(opts: {
  current: string
  isInstalled: boolean
  configEnabled: boolean
  env: Record<string, string | undefined>
}): SkipReason | null {
  const envSkip = isEnvOptOut(opts.env) ? ('disabled-env' as const) : null
  if (envSkip !== null) return envSkip
  if (!opts.configEnabled) return 'disabled-config'
  if (!opts.isInstalled) return 'dev-checkout'
  if (!isReleaseVersion(opts.current)) return 'not-release'
  return null
}

function isEnvOptOut(env: Record<string, string | undefined>): boolean {
  if (truthy(env.TYPECLAW_NO_UPDATE_CHECK)) return true
  if (truthy(env.NO_UPDATE_NOTIFIER)) return true
  if (truthy(env.CI)) return true
  return false
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

// True when the last refresh ATTEMPT is within the TTL — so a failed fetch
// throttles re-checks just as a success does. Keyed on `lastAttemptAt`, not
// `checkedAt`, so npm being down doesn't reopen the per-invocation respawn.
// `now` is injectable for tests.
export function isCacheFresh(cache: VersionCache | null, now: number): boolean {
  if (cache === null) return false
  const age = now - cache.lastAttemptAt
  return age >= 0 && age < CACHE_TTL_MS
}

export async function readVersionCache(): Promise<VersionCache | null> {
  let raw: string
  try {
    raw = await readFile(versionCachePath(), 'utf8')
  } catch {
    return null
  }
  return parseVersionCache(raw)
}

export function parseVersionCache(raw: string): VersionCache | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { latest, checkedAt, lastAttemptAt } = parsed as Record<string, unknown>
  const hasLatest = typeof latest === 'string' && typeof checkedAt === 'number'
  // Back-compat: a pre-throttle cache has only latest+checkedAt; treat its
  // checkedAt as the attempt marker so an upgrade doesn't reset the throttle.
  const attempt = typeof lastAttemptAt === 'number' ? lastAttemptAt : hasLatest ? (checkedAt as number) : undefined
  if (attempt === undefined) return null
  const result: VersionCache = { lastAttemptAt: attempt }
  if (hasLatest) {
    result.latest = latest as string
    result.checkedAt = checkedAt as number
  }
  return result
}

async function writeVersionCache(cache: VersionCache): Promise<void> {
  await mkdir(homeRoot(), { recursive: true }).catch(() => {})
  const final = versionCachePath()
  const tmp = `${final}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 })
  await rename(tmp, final)
}

// Hits the npm registry for the published `latest` version. Returns null on any
// failure (network, non-200, malformed body, non-release version) — the caller
// never surfaces the error; a failed check is a silent no-op by design.
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let body: unknown
    try {
      const res = await fetch(NPM_LATEST_URL, { signal: controller.signal })
      if (!res.ok) return null
      body = await res.json()
    } finally {
      clearTimeout(timer)
    }
    const version = (body as { version?: unknown })?.version
    if (typeof version !== 'string' || !isReleaseVersion(version)) return null
    return version
  } catch {
    return null
  }
}

// The body of the hidden `typeclaw _update-check` command: refresh the cache
// when stale, otherwise no-op. Wrapped so any throw is swallowed — this runs in
// a detached child whose only job is to leave a fresh cache behind, and it must
// never crash loudly into the log.
export async function runBackgroundCheck(now: number = Date.now()): Promise<void> {
  try {
    const existing = await readVersionCache()
    if (isCacheFresh(existing, now)) return
    const latest = await fetchLatestVersion()
    if (latest === null) {
      // Failure path: still stamp the attempt so the 24h throttle holds, while
      // preserving any previously-fetched latest version for the notice.
      await writeVersionCache({ ...existing, lastAttemptAt: now })
      return
    }
    await writeVersionCache({ latest, checkedAt: now, lastAttemptAt: now })
  } catch {}
}
