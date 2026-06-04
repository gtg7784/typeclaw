export type SandboxMount =
  | { type: 'ro-bind'; source: string; dest: string }
  | { type: 'bind'; source: string; dest: string }
  | { type: 'tmpfs'; dest: string }
  | { type: 'dev'; dest: string }

export type SandboxNetwork = 'none' | 'inherit'

export type SandboxProcStrategy = 'tmpfs' | 'none'

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
