import { ACKNOWLEDGE_GUARDS, type SecurityBlock, isGuardAcknowledged } from '../policy'

export const GUARD_OUTBOUND_SECRET = 'outboundSecret'

const SIGNATURE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { kind: 'aws_secret_access_key', pattern: /(?:aws[_-]?secret|aws_secret_access_key)["'\s:=]+[A-Za-z0-9/+=]{40}\b/i },
  { kind: 'github_personal_access_token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_oauth_token', pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_user_to_server_token', pattern: /\bghu_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_server_to_server_token', pattern: /\bghs_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_refresh_token', pattern: /\bghr_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_app_token', pattern: /\bghp_[A-Za-z0-9]{255,}\b/ },
  { kind: 'slack_user_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'slack_webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { kind: 'discord_bot_token', pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}\b/ },
  { kind: 'openai_api_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'anthropic_api_key', pattern: /\bsk-ant-(?:api|admin)\d{2,}-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'fireworks_api_key', pattern: /\bfw_[A-Za-z0-9]{20,}\b/ },
  { kind: 'stripe_secret_key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { kind: 'stripe_restricted_key', pattern: /\brk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { kind: 'twilio_account_sid', pattern: /\bAC[a-f0-9]{32}\b/ },
  { kind: 'sendgrid_api_key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: 'square_access_token', pattern: /\bsq0atp-[A-Za-z0-9_-]{22,}\b/ },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: 'pem_private_key_block',
    pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED|ANY)?\s*PRIVATE\s+KEY-----/,
  },
  { kind: 'pem_certificate_request', pattern: /-----BEGIN\s+CERTIFICATE\s+REQUEST-----/ },
  { kind: 'putty_private_key', pattern: /PuTTY-User-Key-File-\d:/ },
  {
    kind: 'env_assignment_with_secret_key',
    pattern:
      /\b(?:[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH))\s*=\s*["']?[A-Za-z0-9+/_=:.,!@#$%^&*()-]{12,}["']?/,
  },
]

const PROCESS_ENV_TARGETS: ReadonlyArray<string> = [
  'FIREWORKS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_USER_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
  'NOTION_TOKEN',
  'STRIPE_SECRET_KEY',
  'TYPECLAW_HOSTD_TOKEN',
]

const TEXT_KEYS = ['text', 'message', 'content', 'body']

export type OutboundSecretMatch = {
  kind: string
  source: 'signature' | 'process_env'
}

export function findOutboundSecrets(text: string, env: NodeJS.ProcessEnv = process.env): OutboundSecretMatch[] {
  const hits: OutboundSecretMatch[] = []
  const seen = new Set<string>()

  for (const { kind, pattern } of SIGNATURE_PATTERNS) {
    if (pattern.test(text)) {
      const dedup = `signature:${kind}`
      if (!seen.has(dedup)) {
        seen.add(dedup)
        hits.push({ kind, source: 'signature' })
      }
    }
  }

  for (const name of PROCESS_ENV_TARGETS) {
    const value = env[name]
    if (typeof value !== 'string' || value.length < 16) continue
    if (text.includes(value)) {
      const dedup = `env:${name}`
      if (!seen.has(dedup)) {
        seen.add(dedup)
        hits.push({ kind: name, source: 'process_env' })
      }
    }
  }

  return hits
}

export function checkOutboundSecretGuard(options: {
  tool: string
  args: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'channel_send' && tool !== 'channel_reply') return undefined
  if (isGuardAcknowledged(args, GUARD_OUTBOUND_SECRET)) return undefined

  const env = options.env ?? process.env
  for (const key of TEXT_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) continue
    const matches = findOutboundSecrets(value, env)
    if (matches.length === 0) continue

    const summary = matches.map((m) => (m.source === 'process_env' ? `process.env.${m.kind}` : m.kind)).join(', ')
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_OUTBOUND_SECRET}\` blocked ${tool}: outbound text contains likely credentials (${summary}).`,
        'Posting secrets to a channel persists them in chat history and exposes them to every reader.',
        `If this is genuinely intentional and the value is not actually sensitive, retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_OUTBOUND_SECRET}: true\` in the tool arguments.`,
      ].join(' '),
    }
  }
  return undefined
}
