export type InstallResult = { ok: true } | { ok: false; reason: string }

export type InstallRunnerOptions = {
  // Append `--force` to the bun install argv to bypass the cache for
  // `file:` / `link:` deps. Bun treats name+version of a `file:` dep as a
  // cache hit even after the source on disk has changed, so changes to a
  // locally-linked typeclaw never propagate into <agent>/node_modules until
  // either the typeclaw version is bumped or the install is forced.
  force?: boolean
}

// Signature for the function `runInit` uses to materialize the agent folder's
// dependencies. Exposed as a named type so callers (and tests) can pass their
// own stub without re-declaring the shape, mirroring `HatchRunner` and
// `KakaotalkAuthRunner` in `./index.ts`.
export type InstallRunner = (cwd: string, opts?: InstallRunnerOptions) => Promise<InstallResult>

export async function runBunInstall(cwd: string, opts?: InstallRunnerOptions): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    const proc = bun.spawn({
      // `--linker=hoisted` sidesteps a deadlock in Bun 1.3.x's isolated linker
      // (the default since 1.3.0). When any single package fetch fails — 401,
      // SHA-512 mismatch, transient registry 5xx, the kind of flake that's
      // routine on GitHub Actions shared-IP runners — the isolated linker
      // hangs the process indefinitely instead of erroring out
      // (oven-sh/bun#26341, oven-sh/bun#29646). `bun install` runs here over
      // ~500 transitive packages with no lockfile, so the odds of triggering
      // the bug are non-trivial. Hoisted is the fallback strategy bun shipped
      // before 1.3 — slightly slower for huge monorepos, indistinguishable
      // for an agent folder, and not affected by the bug.
      //
      // `--force` is conditional: it bypasses the package cache so file:/link:
      // deps re-copy their current on-disk source into node_modules. Bun's
      // file-dep cache is keyed on name+version, so without --force, edits to
      // a `file:..` typeclaw never reach the container after the first install.
      cmd: opts?.force ? ['bun', 'install', '--linker=hoisted', '--force'] : ['bun', 'install', '--linker=hoisted'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code === 0) return { ok: true }
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, reason: `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Signature for the function that re-resolves a SINGLE dep against its
// current spec. Distinct from InstallRunner because the auto-upgrade path
// MUST force re-resolution against the registry (lockfile-honoring `bun
// install` would no-op when the existing lockfile entry already satisfies
// an in-range spec — which is the exact regression auto-upgrade exists to
// prevent).
export type UpdateRunner = (cwd: string, pkg: string) => Promise<InstallResult>

export async function runBunUpdate(cwd: string, pkg: string): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    const proc = bun.spawn({
      // `bun update <pkg> --latest` re-resolves <pkg> against the registry,
      // capped by the spec in package.json. For a caret/tilde range this
      // pulls the highest in-range version (the case `bun install` won't
      // upgrade because the lockfile already satisfies the spec). For an
      // exact pin it's effectively a force re-fetch of that exact version.
      // `--linker=hoisted` for the same Bun 1.3.x deadlock reason as
      // runBunInstall above.
      cmd: ['bun', 'update', pkg, '--latest', '--linker=hoisted'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code === 0) return { ok: true }
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, reason: `bun update ${pkg} exited with code ${code}: ${stderr.trim() || 'no stderr'}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
