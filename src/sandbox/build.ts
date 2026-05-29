import { SandboxPolicyError } from './errors'
import {
  DEFAULT_SANDBOX_ENV,
  type SandboxCommandFilter,
  type SandboxEnvPolicy,
  type SandboxMount,
  type SandboxPolicy,
} from './policy'
import { formatCommand } from './quote'

export type SandboxedCommand = {
  argv: string[]
  commandString: string
}

// Fixed fd the rendered commandString opens to /dev/null for --ro-bind-data
// file masks. 3 is the first fd above stdio; the bash tool's spawn does not
// inherit it, so the redirect is part of the command string itself.
const MASK_DATA_FD = 3

// Pure: no I/O, no bwrap availability probe (that is `ensureBwrapAvailable`'s
// job). Given a bash command and a policy, returns the bwrap-wrapped argv plus
// a shell-quoted rendering of it. Knows nothing about subagents, origins, or
// the agent runtime — a consumer resolves a policy from whatever context it
// has and calls this. Throws SandboxPolicyError only when the consumer opted
// into the command-filter knobs and the command violates them.
export function buildSandboxedCommand(command: string, policy: SandboxPolicy = {}): SandboxedCommand {
  if (policy.commandFilter !== undefined) {
    applyCommandFilter(command, policy.commandFilter)
  }
  const argv = buildArgv(command, policy)
  const needsMaskFd = (policy.masks?.files?.length ?? 0) > 0
  const commandString = needsMaskFd ? `${formatCommand(argv)} ${MASK_DATA_FD}</dev/null` : formatCommand(argv)
  return { argv, commandString }
}

function buildArgv(command: string, policy: SandboxPolicy): string[] {
  const bwrap = policy.bwrapPath ?? 'bwrap'
  const argv: string[] = [bwrap, '--unshare-all']

  if (policy.network === 'inherit') {
    // --unshare-all already unshared the net namespace; --share-net rejoins
    // the outer container's network. Other namespaces (user/pid/mount/ipc/
    // uts/cgroup) stay unshared. Default ('none' / undefined) leaves the net
    // namespace isolated — prompt-injected bash cannot exfiltrate over the
    // network without the consumer explicitly opting in.
    argv.push('--share-net')
  }

  const proc = policy.process ?? {}
  if (proc.newSession !== false) {
    // Drops the controlling terminal so the contained process cannot push
    // input back into the agent's tty via TIOCSTI. Mandated by
    // docs/internals/sandbox.mdx. Harmless for a one-shot `bash -c`.
    argv.push('--new-session')
  }
  if (proc.dieWithParent !== false) {
    argv.push('--die-with-parent')
  }

  argv.push('--clearenv')
  for (const [key, value] of Object.entries(resolveEnv(policy.env))) {
    argv.push('--setenv', key, value)
  }

  argv.push('--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc', '--dev', '/dev', '--tmpfs', '/tmp')

  if ((policy.proc ?? 'tmpfs') === 'tmpfs') {
    // --tmpfs /proc, never --proc /proc (OrbStack's kernel blocks
    // mount("proc",...) from user namespaces) and never --dev-bind /proc /proc
    // (leaks the outer container's /proc/N/environ — including
    // FIREWORKS_API_KEY — into the sandbox). See sandbox.mdx.
    argv.push('--tmpfs', '/proc')
  }

  for (const mount of policy.mounts ?? []) {
    appendMount(argv, mount)
  }

  appendMasks(argv, policy)

  if (policy.cwd !== undefined) {
    argv.push('--chdir', policy.cwd)
  }

  argv.push('bash', '-c', command)
  return argv
}

function appendMasks(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.masks?.dirs ?? []) {
    argv.push('--tmpfs', dir)
  }
  for (const file of policy.masks?.files ?? []) {
    argv.push('--ro-bind-data', String(MASK_DATA_FD), file)
  }
}

function appendMount(argv: string[], mount: SandboxMount): void {
  switch (mount.type) {
    case 'ro-bind':
      argv.push('--ro-bind', mount.source, mount.dest)
      return
    case 'bind':
      argv.push('--bind', mount.source, mount.dest)
      return
    case 'tmpfs':
      argv.push('--tmpfs', mount.dest)
      return
    case 'dev':
      argv.push('--dev', mount.dest)
      return
  }
}

function resolveEnv(env: SandboxEnvPolicy | undefined): Record<string, string> {
  const resolved: Record<string, string> = { ...DEFAULT_SANDBOX_ENV, ...env?.set }
  for (const key of env?.passthrough ?? []) {
    const value = process.env[key]
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

// Token-boundary match: the normalized command must equal a prefix exactly or
// start with `prefix + ' '`. Substring matching would let `git-evil ...` slip
// past a `git` prefix; this does not.
const ALLOWLIST_WHITESPACE = /\s+/g
const FORBIDDEN_METACHARS = /[;&|`$()<>\\\n]/

function applyCommandFilter(command: string, filter: SandboxCommandFilter): void {
  if (filter.rejectShellMetacharacters === true && FORBIDDEN_METACHARS.test(command)) {
    throw new SandboxPolicyError(
      'command contains a forbidden shell metacharacter. This policy only permits simple commands without ; & | ` $ ( ) < > \\ or newlines.',
    )
  }
  if (filter.allowPrefixes !== undefined) {
    const normalized = command.trim().replace(ALLOWLIST_WHITESPACE, ' ')
    const matched = filter.allowPrefixes.some((p) => normalized === p || normalized.startsWith(`${p} `))
    if (!matched) {
      throw new SandboxPolicyError(
        `command does not match any allowed prefix. Allowed: ${filter.allowPrefixes.join(', ')}`,
      )
    }
  }
}
