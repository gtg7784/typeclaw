// Preloaded by bunfig.toml `[test] preload`. Two responsibilities:
//   1. Deny `bun test` without --parallel.
//   2. Raise the per-test default timeout from Bun's 5000ms.
//
// Why deny serial runs: Serial runs are ~3.4x slower (44s → 13s, see commit
// 1c66d5e), and Bun has no bunfig knob for the flag yet (verified against
// bunfig.zig in oven-sh/bun main, May 2026). Without this guard, IDE test
// runners and ad-hoc shells silently fall back to the slow path.
//
// Detection: Bun strips CLI flags from `Bun.argv` before invoking the
// preload, so we can't scrape the flag directly. Instead we look for
// BUN_TEST_WORKER_ID, which Bun sets in the preload env exactly when
// `--parallel` is active (the variable carries the worker index for the
// IPC handshake between coordinator and workers). Empirically verified
// against bun 1.3.14: present under --parallel, absent under serial. If
// a future Bun version renames this var, the guard fails closed (treats
// every run as serial → always denies), which is the safe direction.
//
// Bypass with TYPECLAW_ALLOW_SERIAL_TESTS=1 when debugging a flaky test
// where worker contention obscures the failure.
//
// Why raise the default timeout: A growing number of tests in this repo
// either spawn child processes (`bun run typeclaw …` via Bun.spawn from
// src/cli/index.test.ts, src/cli/role.test.ts, src/cli/status.test.ts,
// src/init/dockerfile.test.ts agent-browser wrapper, etc.) or boot the
// in-process agent (`startAgent({ port: 0, … })` from src/run/plugin.test.ts).
// Both shapes have a happy-path cost well under 1s but a worst-case cost
// that races Bun's 5000ms ceiling under `--parallel` contention. The
// repeating failure mode is "this test timed out after 5000ms" appearing
// on different tests across runs at a rough ~3-15% rate per full-suite
// invocation — not a real bug, just resource starvation. Raising the
// default to 30s eliminates the false positives without masking real
// hangs (a wedged test still fails, just 6x slower than before). The
// happy path is unaffected because tests complete in their actual
// runtime, not the timeout budget.
//
// 30s was chosen as ~75x the observed happy-path cold-start (~400ms) for
// the heaviest subprocess tests, matching the in-house convention used in
// pi-coding-agent's subprocess fixtures and Bun's own integration-test
// suites (see oven-sh/bun test/cli/install/*.test.ts which set 5-minute
// timeouts for full installs). Individual tests that genuinely need more
// can still pass an explicit 3rd arg to `test()` to override locally.

import { setDefaultTimeout } from 'bun:test'

const isParallelWorker = typeof process.env.BUN_TEST_WORKER_ID === 'string'

if (isParallelWorker) {
  setDefaultTimeout(30_000)
} else if (process.env.TYPECLAW_ALLOW_SERIAL_TESTS === '1') {
  console.warn('[require-parallel] Running serially — TYPECLAW_ALLOW_SERIAL_TESTS=1 set.')
  setDefaultTimeout(30_000)
} else {
  console.error('')
  console.error('  ✗ `bun test` without --parallel is denied in this repo.')
  console.error('')
  console.error('    Serial runs take ~46s; --parallel cuts that to ~14s on a multi-core')
  console.error('    machine and is what CI uses. Bun does not (yet) accept `[test] parallel`')
  console.error('    in bunfig.toml, so we enforce it via this preload.')
  console.error('')
  console.error('    Use one of:')
  console.error('      bun run test                              # preferred')
  console.error('      bun test --parallel                       # direct')
  console.error('      TYPECLAW_ALLOW_SERIAL_TESTS=1 bun test    # intentional serial run')
  console.error('')
  process.exit(1)
}
