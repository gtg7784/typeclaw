// Defense-in-depth backstop against credential leakage into memory streams.
// The memory-logger system prompt forbids quoting secret values, but the LLM
// occasionally violates that rule by quoting `env | grep` output verbatim as
// "evidence". Once a secret reaches a daily stream file, dreaming promotes it
// into MEMORY.md and the runtime force-commits both to git — at which point
// rotation is the only recourse. We deliberately avoid generic high-entropy
// heuristics: false positives here would silently lose legitimate fragments.

export type SecretRule = {
  readonly name: string
  readonly pattern: RegExp
}

export const SECRET_RULES: readonly SecretRule[] = [
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'github-classic-pat', pattern: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-server', pattern: /\bghs_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-user-server', pattern: /\bghu_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-refresh', pattern: /\bghr_[A-Za-z0-9]{30,}\b/ },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai-key', pattern: /\bsk-(?!ant-)(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'slack-bot-token', pattern: /\bxoxb-[0-9A-Za-z-]{20,}\b/ },
  { name: 'slack-user-token', pattern: /\bxoxp-[0-9A-Za-z-]{20,}\b/ },
  { name: 'slack-app-token', pattern: /\bxapp-[0-9A-Za-z-]{20,}\b/ },
  { name: 'slack-workspace-token', pattern: /\bxoxa-[0-9A-Za-z-]{20,}\b/ },
  { name: 'slack-refresh-token', pattern: /\bxoxe-[0-9A-Za-z-]{20,}\b/ },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'stripe-secret', pattern: /\bsk_live_[0-9A-Za-z]{24,}\b/ },
  { name: 'stripe-restricted', pattern: /\brk_live_[0-9A-Za-z]{24,}\b/ },
  { name: 'rsa-private-key', pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
]

export type SecretMatch = {
  readonly rule: string
  readonly index: number
}

export function detectSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = []
  for (const rule of SECRET_RULES) {
    const match = content.match(rule.pattern)
    if (match !== null && match.index !== undefined) {
      matches.push({ rule: rule.name, index: match.index })
    }
  }
  return matches
}
