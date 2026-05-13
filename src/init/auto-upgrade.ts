import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveScaffoldVersion } from './cli-version'

const PACKAGE_FILE = 'package.json'
const TYPECLAW = 'typeclaw'

// Pre-1.0 caret semantics are the whole reason this module exists:
//   `^0.1.0` resolves to >=0.1.0 <0.2.0 (minor pins the range, not major).
// So a CLI bump from 0.1.x to 0.2.0 falls OUT of the agent's existing
// `^0.1.x` range — bun install would refuse to upgrade. We have to rewrite
// the spec for those crossings. In-range drift (0.1.0 → 0.1.2) only needs
// a `bun install` re-run. Exact pins (`0.1.0` without `^`/`~`) are user
// intent and never auto-rewritten — see exact-pin branch below.

export type AutoUpgradeOutcome =
  | { kind: 'skipped-dev-mode' }
  | { kind: 'skipped-no-dep' }
  | { kind: 'skipped-non-release-spec'; declared: string }
  | { kind: 'up-to-date'; installedVersion: string }
  | { kind: 'exact-pin-respected'; declared: string; cliVersion: string }
  | { kind: 'spec-rewritten'; from: string; to: string }
  | { kind: 'reinstall-needed'; from: string; to: string }

export type AutoUpgradeOptions = {
  cwd: string
  // Test seam: lets tests simulate dev-mode (null) and arbitrary release
  // versions without depending on the test runner's actual CLI version.
  scaffoldVersion?: string | null
}

export async function autoUpgradeTypeclawDep(options: AutoUpgradeOptions): Promise<AutoUpgradeOutcome> {
  const { cwd } = options
  const scaffold = options.scaffoldVersion !== undefined ? options.scaffoldVersion : resolveScaffoldVersion()
  if (scaffold === null) return { kind: 'skipped-dev-mode' }

  const cliVersion = stripCaret(scaffold)
  if (cliVersion === null) return { kind: 'skipped-dev-mode' }

  const pkg = await readAgentPackageJson(cwd)
  if (pkg === null) return { kind: 'skipped-no-dep' }

  const declared = pkg.parsed.dependencies?.[TYPECLAW]
  if (typeof declared !== 'string') return { kind: 'skipped-no-dep' }

  const declaredKind = classifyDepSpec(declared)
  if (declaredKind.kind === 'non-release') {
    return { kind: 'skipped-non-release-spec', declared }
  }

  const installed = readInstalledTypeclawVersion(cwd)

  // Exact pin: silently rewriting violates user intent (they wrote `0.1.0`
  // with no operator deliberately — testing a held-back version, debugging
  // a regression, etc). Surface the divergence as a warning and proceed.
  if (declaredKind.kind === 'exact') {
    const declaredVersion = formatTriple(declaredKind.version)
    if (declaredVersion === cliVersion) {
      return { kind: 'up-to-date', installedVersion: installed ?? cliVersion }
    }
    return { kind: 'exact-pin-respected', declared, cliVersion }
  }

  // "Upgrade only, never downgrade." The agent's effective version is the
  // max of (installed copy, declared range floor). If that already meets or
  // exceeds the CLI, leave everything alone — even when the range itself
  // does not include the CLI version (e.g. `^0.1.5` against CLI 0.1.2).
  const declaredFloor = formatTriple(declaredKind.version)
  const effective =
    installed !== null && compareReleaseVersions(installed, declaredFloor) > 0 ? installed : declaredFloor
  if (compareReleaseVersions(effective, cliVersion) >= 0) {
    return { kind: 'up-to-date', installedVersion: installed ?? declaredFloor }
  }

  if (!rangeSatisfies(declaredKind, cliVersion)) {
    const newSpec = `^${cliVersion}`
    await writeDepSpec(cwd, pkg.raw, pkg.parsed, newSpec)
    return { kind: 'spec-rewritten', from: declared, to: newSpec }
  }

  if (installed === null) {
    return { kind: 'up-to-date', installedVersion: cliVersion }
  }
  return { kind: 'reinstall-needed', from: installed, to: cliVersion }
}

export function outcomeForcesInstall(outcome: AutoUpgradeOutcome): boolean {
  return outcome.kind === 'spec-rewritten' || outcome.kind === 'reinstall-needed'
}

export function describeAutoUpgrade(outcome: AutoUpgradeOutcome): string {
  switch (outcome.kind) {
    case 'spec-rewritten':
    case 'reinstall-needed':
      return `Upgrading agent typeclaw ${outcome.from} → ${outcome.to} to match CLI`
    case 'exact-pin-respected':
      return `Agent typeclaw is exact-pinned to ${outcome.declared}; CLI is ${outcome.cliVersion}. Not upgrading (remove the exact pin to allow auto-upgrade).`
    default:
      return ''
  }
}

type ParsedPackage = {
  raw: string
  parsed: { dependencies?: Record<string, string> } & Record<string, unknown>
}

async function readAgentPackageJson(cwd: string): Promise<ParsedPackage | null> {
  const path = join(cwd, PACKAGE_FILE)
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return { raw, parsed: parsed as ParsedPackage['parsed'] }
}

function readInstalledTypeclawVersion(cwd: string): string | null {
  const path = join(cwd, 'node_modules', TYPECLAW, PACKAGE_FILE)
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { version?: string }
    if (typeof parsed.version === 'string' && isReleaseVersion(parsed.version)) return parsed.version
  } catch {}
  return null
}

type DepSpecKind =
  | { kind: 'exact'; version: [number, number, number]; raw: string }
  | { kind: 'caret'; version: [number, number, number] }
  | { kind: 'tilde'; version: [number, number, number] }
  | { kind: 'non-release' }

function classifyDepSpec(spec: string): DepSpecKind {
  const trimmed = spec.trim()
  const exactMatch = trimmed.match(/^=?(\d+)\.(\d+)\.(\d+)$/)
  if (exactMatch) {
    const [, a, b, c] = exactMatch
    return { kind: 'exact', version: parseTriple(a!, b!, c!), raw: trimmed }
  }
  const caretMatch = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)$/)
  if (caretMatch) {
    const [, a, b, c] = caretMatch
    return { kind: 'caret', version: parseTriple(a!, b!, c!) }
  }
  const tildeMatch = trimmed.match(/^~(\d+)\.(\d+)\.(\d+)$/)
  if (tildeMatch) {
    const [, a, b, c] = tildeMatch
    return { kind: 'tilde', version: parseTriple(a!, b!, c!) }
  }
  return { kind: 'non-release' }
}

function parseTriple(a: string, b: string, c: string): [number, number, number] {
  return [Number.parseInt(a, 10), Number.parseInt(b, 10), Number.parseInt(c, 10)]
}

function formatTriple(v: [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

// npm/bun caret+tilde semantics, narrowed to plain X.Y.Z bases:
//   ^0.1.2 → >=0.1.2 <0.2.0   (pre-1.0 caret pins minor — the bug we fix)
//   ^1.2.3 → >=1.2.3 <2.0.0
//   ~0.1.2 → >=0.1.2 <0.2.0
//   ~1.2.3 → >=1.2.3 <1.3.0
function rangeSatisfies(range: Exclude<DepSpecKind, { kind: 'exact' | 'non-release' }>, version: string): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  const [base, ceiling] = rangeBounds(range)
  return compareTriples(v, base) >= 0 && compareTriples(v, ceiling) < 0
}

function rangeBounds(
  range: Exclude<DepSpecKind, { kind: 'exact' | 'non-release' }>,
): [[number, number, number], [number, number, number]] {
  const [maj, min, pat] = range.version
  if (range.kind === 'caret') {
    if (maj > 0)
      return [
        [maj, min, pat],
        [maj + 1, 0, 0],
      ]
    if (min > 0)
      return [
        [maj, min, pat],
        [maj, min + 1, 0],
      ]
    return [
      [maj, min, pat],
      [maj, min, pat + 1],
    ]
  }
  return [
    [maj, min, pat],
    [maj, min + 1, 0],
  ]
}

function parseVersion(version: string): [number, number, number] | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  const [, a, b, c] = m
  return parseTriple(a!, b!, c!)
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const ai = a[i]!
    const bi = b[i]!
    if (ai !== bi) return ai - bi
  }
  return 0
}

function compareReleaseVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  if (av === null || bv === null) return 0
  return compareTriples(av, bv)
}

function stripCaret(scaffold: string): string | null {
  const m = scaffold.match(/^\^?(\d+\.\d+\.\d+)$/)
  return m ? (m[1] ?? null) : null
}

function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

async function writeDepSpec(cwd: string, raw: string, parsed: ParsedPackage['parsed'], newSpec: string): Promise<void> {
  // Preserve user formatting (indentation, trailing newline, key order) by
  // editing the raw string. Round-tripping through JSON.stringify would
  // reorder keys and erase user-applied whitespace choices. Fallback below
  // only kicks in for pathological package.json shapes where the regex
  // can't anchor on the typeclaw key.
  const replaced = raw.replace(
    /("typeclaw"\s*:\s*)"[^"]+"/,
    (_match, prefix: string) => `${prefix}${JSON.stringify(newSpec)}`,
  )
  if (replaced !== raw) {
    await writeFile(join(cwd, PACKAGE_FILE), replaced)
    return
  }
  const deps = { ...parsed.dependencies, [TYPECLAW]: newSpec }
  const next = { ...parsed, dependencies: deps }
  await writeFile(join(cwd, PACKAGE_FILE), `${JSON.stringify(next, null, 2)}\n`)
}
