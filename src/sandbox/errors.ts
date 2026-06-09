export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'
  constructor() {
    super(
      'sandbox unavailable: bwrap binary not found on PATH. Refusing to run a command that requires sandboxing without the kernel boundary in place.',
    )
  }
}

// Raised by the optional command-filter knobs (allowPrefixes,
// rejectShellMetacharacters). These are consumer-opt-in restrictions layered
// ABOVE the always-on kernel containment, so a rejection here is a policy
// decision the consumer asked for — not a failure of the sandbox itself. The
// message is phrased for the model to read and self-correct from.
export class SandboxPolicyError extends Error {
  override readonly name = 'SandboxPolicyError'
  constructor(reason: string) {
    super(`sandbox policy rejected command: ${reason}`)
  }
}

// Raised when the /proc strategy degraded to the empty `tmpfs` fallback AND the
// command needs a real /proc (a bun install / bunx / bun run that reads the
// kernel-backed /proc/self/{fd,maps}). Without this pre-check Bun aborts deep in
// its install pipeline with the opaque "NotDir" (ENOTDIR) error, which the model
// misreads as a bad package or a transient hiccup and retries forever. Surfacing
// it here, before the command runs, turns the failure into one the operator (or
// the model) can act on: it is an environment/runtime limitation, not the
// command's fault, so retrying the same command on the same container is futile.
export class SandboxDegradedProcError extends Error {
  override readonly name = 'SandboxDegradedProcError'
  constructor() {
    super(
      'sandbox /proc is in degraded tmpfs mode, so bun package commands ' +
        '(bun install / bun add / bunx / bun run) cannot run: Bun needs a real ' +
        '/proc/self/fd, which this strategy cannot provide, and would otherwise ' +
        'fail with an opaque "NotDir" error. This is a container/runtime limitation ' +
        '(no usable user namespaces for the cap-free proc-bind strategy), not a ' +
        'problem with the command or the package. Retrying the same command will ' +
        'not help; report it as a sandbox/environment issue.',
    )
  }
}
