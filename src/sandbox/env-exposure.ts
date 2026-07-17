import { DEFAULT_SANDBOX_ENV } from './policy'

// DEFAULT_SANDBOX_ENV names are sandbox-OWNED: build.ts renders them via
// --setenv, but an inherited name skips that --setenv (inherit keeps the parent
// value), so letting `.env` PATH/HOME/BUN_* through would REPLACE the sandbox's
// safe fixed values — a PATH/loader hijack of the sandbox mechanism itself.
const RESERVED_SANDBOX_ENV_NAMES = new Set(Object.keys(DEFAULT_SANDBOX_ENV))

// Names TypeClaw's own runtime/broker OWNS: github-cli-auth gates GH_TOKEN /
// GITHUB_TOKEN behind a capability + command-scoped overlay (only a validated
// `gh` call gets the token, out of argv), and the TYPECLAW_* tokens are
// host/container-injected auth. Ambient inheritance would bypass the broker and
// hand a reusable credential to arbitrary bash — so these are withheld even when
// declared in `.env`. Not a credential-name registry: these five names are ones
// the runtime CLAIMS, distinct from operator credentials (which belong in
// secrets.json). A matching `.env` line would otherwise make the runtime value
// eligible; the parsed-value gate (below) also blocks the empty-declaration case.
const RUNTIME_OWNED_ENV_NAMES = new Set<string>([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'TYPECLAW_TUI_TOKEN',
  'TYPECLAW_HOSTD_TOKEN',
  'TYPECLAW_HOSTD_BROKER_TOKEN',
])

// Process-hijack vectors: an inherited value here changes how the shell, loader,
// or a runtime INTERPRETS later commands (arbitrary code load, config override,
// credential-socket handoff). SHELLOPTS/BASHOPTS/PS4/BASH_XTRACEFD and the
// BASH_FUNC_ prefix are OUTER-shell controls that execute in the `bash -c` that
// launches bwrap — before confinement begins (e.g. SHELLOPTS=xtrace + a
// command-substituting PS4, or an exported `BASH_FUNC_bwrap%%` replacing the
// bwrap command). These subvert the sandbox rather than expose a value.
const EXECUTION_CONTROL_ENV_NAMES = new Set<string>([
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'BASH_XTRACEFD',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5OPT',
  'SSH_AUTH_SOCK',
  'KUBECONFIG',
])

const EXECUTION_CONTROL_ENV_PREFIXES = ['GIT_CONFIG', 'BASH_FUNC_'] as const

// Withheld ONLY when the name would compromise sandbox integrity or the runtime
// credential broker — not for being credential-shaped. `.env` is the operator's
// expose-to-the-agent surface: every value they declare there reaches model bash
// by design. Credentials that must stay hidden belong in secrets.json.
function isWithheldEnvName(name: string): boolean {
  if (RESERVED_SANDBOX_ENV_NAMES.has(name)) return true
  if (RUNTIME_OWNED_ENV_NAMES.has(name)) return true
  if (EXECUTION_CONTROL_ENV_NAMES.has(name)) return true
  return EXECUTION_CONTROL_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))
}

// Every name an operator declared in the `.env` FILE with a non-empty value,
// minus the sandbox-integrity/broker withholds. Eligibility is decided from the
// PARSED `.env` value, never process.env: an empty `.env` line (`X=`) is not an
// operator expose-choice even if hydrateChannelEnvFromSecrets later fills
// process.env[X] from secrets.json. The inherited VALUE is still snapshotted
// from process.env at spawn time.
export function resolveExposableEnvNames(declaredEnv: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const [name, fileValue] of declaredEnv) {
    if (fileValue.length === 0) continue
    if (isWithheldEnvName(name)) continue
    out.push(name)
  }
  return out
}
