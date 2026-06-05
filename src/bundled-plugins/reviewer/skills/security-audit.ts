import type { LoadableSkill } from '@/plugin'

export const SECURITY_AUDIT_SKILL_NAME = 'security-audit'

export const SECURITY_AUDIT_SKILL_DESCRIPTION =
  'Audit code or configuration through a threat-model lens: injection, broken access control, SSRF, insecure deserialization, secrets exposure, path traversal, TOCTOU, and cryptographic failures. Maps findings to OWASP/CWE and reasons about exploitability, not style.'

export const SECURITY_AUDIT_SKILL_CONTENT = `# security-audit

You have been asked to audit a target for security defects. This is not a general code review with a security flavor — it is an adversarial read. Assume an attacker controls every input the target does not prove it controls, and ask what they can make happen. Apply this on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **A PR or diff** — \`gh pr diff <n>\` for the change; then \`read\` the surrounding code, because a vulnerability often lives in the interaction between the changed line and an untouched caller.
- **A file or module** — \`read\` it, then \`grep\` for the entry points: where does external input enter, and where does it reach a sink (a shell, a query, a file path, a deserializer, an outbound request)?
- **Config / infra** — \`read\` the manifest, Dockerfile, CI workflow, or IaC. Misconfiguration is a vulnerability class of its own (default credentials, over-broad permissions, secrets in plaintext).
- **Verify with primary sources.** When you cite a class (OWASP A03, CWE-89, an RFC), confirm the current definition with \`web_search\`/\`web_fetch\` before asserting it. Cite by identifier.

## Trace input to sink

A security finding is a *path*: untrusted input → (insufficient validation) → dangerous sink. Name both ends and the missing control between them. A finding that only says "this looks unsafe" without tracing the path is not actionable. For each entry point, follow the data: where does it go, what touches it on the way, and what does it reach?

## What to look for

Prioritize by exploitability, roughly in this order:

1. **Injection (CWE-78/89/79/90).** Untrusted input concatenated into a shell command, SQL/NoSQL query, LDAP filter, or HTML sink without parameterization or escaping. OS-command injection via string-interpolated \`bash\` is the highest-value catch.
2. **Broken access control (OWASP A01).** Missing authorization checks, IDOR (a user can read/write another user's object by changing an ID), endpoints that trust a client-supplied role, path-based bypass.
3. **SSRF (OWASP A10 / CWE-918).** The server fetches a user-supplied URL with no allowlist, letting an attacker reach internal services or cloud metadata endpoints (\`169.254.169.254\`). Flag any outbound request whose destination is attacker-influenced.
4. **Insecure deserialization / data-integrity (OWASP A08).** Untrusted bytes fed to a deserializer that can instantiate arbitrary types; unsigned updates; a pipeline that trusts input it did not verify.
5. **Cryptographic failures (OWASP A02).** Secrets at rest in plaintext, weak or broken hashes (MD5/SHA1 for passwords), missing TLS on sensitive transit, hardcoded keys, predictable tokens.
6. **Secrets exposure.** API keys, tokens, or passwords in logs, error messages, committed config, or echoed in responses. A stack trace returned to the client is an information-disclosure finding.
7. **Path traversal (CWE-22).** User input builds a filesystem path without canonicalization, allowing \`../\` escape out of the intended directory.
8. **TOCTOU (CWE-367).** A check (file exists, permission ok) separated from the use by a window an attacker can exploit to swap the target.
9. **Authentication weaknesses (OWASP A07).** No brute-force protection, session fixation, missing re-auth on sensitive actions, tokens that never expire.

## Severity via exploitability (CVSS-style reasoning)

Anchor severity to *what an attacker gains and how easily*, not to how the code reads:

- **blocker** — Exploitable now with serious impact: remote code execution, auth bypass, injection reachable from an unauthenticated path, secret disclosure. CVSS roughly High/Critical (7.0+). Do not ship.
- **concern** — A real weakness that requires a precondition (authenticated attacker, user interaction, an unlikely-but-possible input) or whose impact is bounded. CVSS roughly Medium (4.0–6.9).
- **nit** — Defense-in-depth hardening with no demonstrated exploit path: a missing security header, a slightly-too-broad scope that is not currently reachable. Optional.
- **praise** — A non-obvious control done right: input correctly parameterized at a tricky sink, an allowlist that closes an SSRF that an obvious implementation would have left open. Rare.

For blocker and concern findings, state the attack in one sentence: who, with what access, can make what happen. That sentence is what separates a security finding from a style opinion.

## What NOT to find

- **Style and formatting.** Linter territory. A security audit is not the place for naming or spacing.
- **Performance without a security angle.** A slow loop is not a security finding unless it is a denial-of-service vector you can demonstrate.
- **Theoretical issues with no reachable path.** "This *could* be unsafe if someone later calls it with attacker input" — only raise it if such a caller exists or is plausible. Name the path or drop the finding; un-anchored "could be exploited" is the security flavor of generic review noise.
- **Re-flagging controls that are present.** If validation, escaping, or an allowlist already guards the sink, that is not a finding — and if it is done well, it may be a \`praise\`.

## Verdict mapping

- **approve** — No exploitable finding. Any issues are defense-in-depth nits.
- **request-changes** — At least one blocker, or a concern serious enough to answer before this lands.
- **comment** — Observations without a clear gate: a partial audit of a large surface, or hardening advice on code that has no demonstrated vulnerability.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const SECURITY_AUDIT_SKILL: LoadableSkill = {
  name: SECURITY_AUDIT_SKILL_NAME,
  description: SECURITY_AUDIT_SKILL_DESCRIPTION,
  content: SECURITY_AUDIT_SKILL_CONTENT,
}
