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
