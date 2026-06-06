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

  // Recreate the usr-merge root symlinks that --ro-bind /usr does NOT bring
  // along. On the Debian base (oven/bun:1-slim) /bin /sbin /lib /lib64 are
  // root-level symlinks into /usr; binding /usr exposes /usr/bin etc. but the
  // root entries themselves are absent in the sandbox. That breaks every
  // ABSOLUTE-path reference the kernel resolves WITHOUT consulting PATH:
  //   - ELF interpreter (the dynamic loader) baked into PT_INTERP:
  //     /lib/ld-linux-aarch64.so.1 (arm64) or /lib64/ld-linux-x86-64.so.2
  //     (amd64). Missing it makes bwrap report "execvp bash: No such file or
  //     directory" — the missing file is the loader, not bash.
  //   - shebang lines: /bin/sh and /bin/bash are the most common interpreters
  //     on earth; a script with "#!/bin/sh" fails "cannot execute: required
  //     file not found" without /bin, even though /usr/bin/sh exists, because
  //     the shebang path is literal and skips PATH.
  // --ro-bind-try, not --ro-bind: the set is arch- and base-dependent (arm64
  // oven/bun:1-slim ships /lib but no /lib64), and a hard bind of an absent
  // source aborts bwrap. -try binds each only when present, keeping this
  // builder pure (no host filesystem probe) and correct across arches/bases.
  argv.push(
    '--ro-bind-try',
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/sbin',
    '/sbin',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
  )

  if ((policy.proc ?? 'tmpfs') === 'tmpfs') {
    // --tmpfs /proc, never --proc /proc (OrbStack's kernel blocks
    // mount("proc",...) from user namespaces) and never --dev-bind /proc /proc
    // (leaks the outer container's /proc/N/environ — including
    // FIREWORKS_API_KEY — into the sandbox). See sandbox.mdx.
    argv.push('--tmpfs', '/proc')

    // Re-expose ONLY the bun ELF at /proc/self/exe so sandboxed package runners
    // can self-locate; /proc/N/environ stays masked by the tmpfs above. The
    // caller passes bun's path (see resolveProcSelfExe): in this bun-centric
    // container bunx/npx/pnpx all resolve to bun, so bun IS the runtime reading
    // /proc/self/exe. --symlink (not --ro-bind /proc/self/exe): /proc/self at
    // setup time is bwrap's pid, so a bind would capture bwrap's own binary.
    // Must come AFTER --tmpfs /proc (last-op-wins) or the tmpfs erases it.
    if (policy.procSelfExe !== undefined) {
      argv.push('--ro-bind', policy.procSelfExe, policy.procSelfExe)
      argv.push('--symlink', policy.procSelfExe, '/proc/self/exe')
    }
  }

  for (const mount of policy.mounts ?? []) {
    appendMount(argv, mount)
  }

  appendMasks(argv, policy)
  appendWritable(argv, policy)
  appendProtected(argv, policy)

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

function appendWritable(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.writable?.dirs ?? []) {
    argv.push('--bind', dir, dir)
  }
  for (const file of policy.writable?.files ?? []) {
    argv.push('--bind', file, file)
  }
}

function appendProtected(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.protected?.dirs ?? []) {
    argv.push('--ro-bind', dir, dir)
  }
  for (const file of policy.protected?.files ?? []) {
    argv.push('--ro-bind', file, file)
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
