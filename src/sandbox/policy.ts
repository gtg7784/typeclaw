export type SandboxMount =
  | { type: 'ro-bind'; source: string; dest: string }
  | { type: 'bind'; source: string; dest: string }
  | { type: 'tmpfs'; dest: string }
  | { type: 'dev'; dest: string }

export type SandboxNetwork = 'none' | 'inherit'

// 'real-proc' (the runtime default — see sandbox.realProc, default true): mount
// a fresh procfs scoped to a NEW pid namespace so a JS package runner's child
// gets a real /proc/self/{fd,maps} WITHOUT seeing the agent runtime's pids (no
// /proc/<agent>/environ leak). Requires the outer container to hold
// CAP_SYS_ADMIN (mount(2) of proc); start.ts grants it by default and the
// consumer probes that it actually works before choosing this strategy.
// 'tmpfs' (the fallback when CAP_SYS_ADMIN is a no-op, or realProc=false): empty
// /proc + a single /proc/self/exe symlink. Works on every host but gives no
// /proc/self/{fd,maps}, so a JS package runner's CHILD (the spawned bin) crashes
// with ENOTDIR reading /proc/self/fd — external packages can't run in the
// sandbox under this strategy. 'none': no /proc at all.
export type SandboxProcStrategy = 'tmpfs' | 'none' | 'real-proc'

export type SandboxEnvPolicy = {
  set?: Record<string, string>
  passthrough?: string[]
}

export type SandboxCommandFilter = {
  allowPrefixes?: string[]
  rejectShellMetacharacters?: boolean
}

export type SandboxProcessPolicy = {
  newSession?: boolean
  dieWithParent?: boolean
}

// Role-derived deny-list overlaid on top of an already-visible tree. dirs are
// hidden with an empty tmpfs; files are hidden with --ro-bind-data, the only
// bwrap primitive that masks a single FILE (--tmpfs is dir-only). --ro-bind-data
// reads its empty content from a file descriptor, and the bash tool spawns with
// stdio ["ignore","pipe","pipe"] — no inherited extra fds — so the rendered
// commandString self-opens fd MASK_DATA_FD via a `<fd>< /dev/null` redirection
// appended after `bash -c <command>`. Masks MUST render after the broad parent
// mounts: bwrap applies mount ops in command-line order and the last op on a
// path wins, so a mask emitted before its parent bind would be re-exposed.
export type SandboxMaskPolicy = {
  dirs?: string[]
  files?: string[]
}

// Writable carve-outs re-exposed on top of a read-only project root AND its
// masks. Rendered last so "last op wins" makes these the only RW paths: an RW
// bind here overrides the broad --ro-bind parent, while anything not listed
// stays read-only (EROFS) or masked.
export type SandboxWritablePolicy = {
  dirs?: string[]
  files?: string[]
}

// Read-only re-protections carved back out of a writable parent. MUST render
// after `writable` so bwrap's last-op-wins keeps these EROFS despite the parent
// RW bind. Load-bearing: `.git` is writable so members can commit, but
// `.git/hooks` and `.git/config` stay RO here — otherwise a low-trust role
// plants a hook or sets core.hooksPath and gets code execution in the
// unsandboxed runtime git ops (backup/dreaming) that share the same .git.
export type SandboxProtectedPolicy = {
  dirs?: string[]
  files?: string[]
}

export type SandboxPolicy = {
  bwrapPath?: string
  cwd?: string
  // Concrete host interpreter ELF (the running bun binary) re-exposed at
  // /proc/self/exe over the --tmpfs /proc mask. JS runtimes self-locate via
  // /proc/self/exe; under the empty tmpfs /proc that read fails and bunx panics
  // in createFakeTemporaryNodeExecutable. A direct --ro-bind of /proc/self/exe
  // is wrong: at bwrap setup time /proc/self is bwrap's pid, so it captures the
  // bwrap binary, not the child runtime. The caller resolves this path (I/O);
  // the builder stays pure.
  procSelfExe?: string
  mounts?: SandboxMount[]
  masks?: SandboxMaskPolicy
  writable?: SandboxWritablePolicy
  protected?: SandboxProtectedPolicy
  network?: SandboxNetwork
  env?: SandboxEnvPolicy
  commandFilter?: SandboxCommandFilter
  process?: SandboxProcessPolicy
  proc?: SandboxProcStrategy
}

// The env the sandbox always re-introduces after `--clearenv`. Anything not
// listed here (or explicitly named in `env.set` / `env.passthrough` by the
// consumer) is invisible inside the sandbox. This is the load-bearing leak
// guard: the container env holds FIREWORKS_API_KEY and GH_TOKEN, and env
// inheritance is the single highest-risk exfil path for prompt-injected bash.
// HOME points at /tmp because the sandbox mounts /tmp as a fresh tmpfs.
export const DEFAULT_SANDBOX_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C.UTF-8',
}
