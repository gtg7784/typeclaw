import { ACKNOWLEDGE_GUARDS, type SecurityBlock, isGuardAcknowledged } from '../policy'

export const GUARD_SECRET_EXFIL_BASH = 'secretExfilBash'

const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|[\s;|&(`$])(env|printenv)([\s;|&)`]|$)/, label: 'env / printenv (full environment dump)' },
  {
    pattern: /(cat|less|more|head|tail|bat|xxd|od|hexdump|strings)\s+[^\n;|&`]*\.env(\s|$|[;|&`])/,
    label: 'reading .env file',
  },
  { pattern: /(cat|less|more|head|tail|bat)\s+[^\n;|&`]*\.envrc(\s|$|[;|&`])/, label: 'reading .envrc file' },
  { pattern: /\.ssh\/(id_[a-z0-9]+|authorized_keys|known_hosts|config)/i, label: '~/.ssh/* private material' },
  {
    pattern: /(cat|less|more|head|tail|ls|find|grep|rg|bat)\s+[^\n;|&`]*~?\/?\.ssh(\/|\s|$|[;|&`])/,
    label: 'reading ~/.ssh/ directory',
  },
  { pattern: /\.aws\/(credentials|config)/i, label: '~/.aws/credentials' },
  { pattern: /\.docker\/config\.json/i, label: '~/.docker/config.json (registry auth)' },
  { pattern: /\.netrc/i, label: '~/.netrc (HTTP credentials)' },
  { pattern: /\.kube\/config/i, label: '~/.kube/config (cluster credentials)' },
  { pattern: /\.gnupg\//i, label: '~/.gnupg/ (PGP keys)' },
  { pattern: /\.config\/[^\s;|&`]*\/(credentials|token|secret|auth)/i, label: '~/.config/**/credentials-like file' },
  { pattern: /\.hermes\/config/i, label: '~/.hermes/config (agent credentials)' },
  { pattern: /\.config\/hermes\//i, label: '~/.config/hermes/ (agent credentials)' },
  { pattern: /\/proc\/\d*\/environ/, label: '/proc/*/environ' },
  { pattern: /\/proc\/self\/environ/, label: '/proc/self/environ' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?\*?\.env/, label: 'find ... -name "*.env"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?credentials/i, label: 'find ... -name "credentials*"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?[^\n"';|&`]*secret/i, label: 'find ... -name "*secret*"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?id_(rsa|ed25519|ecdsa|dsa)/i, label: 'find ... -name "id_rsa"' },
  {
    pattern: /(grep|rg|ag)\s+[^\n;|&`]*-r[^\n;|&`]*(password|api[_-]?key|secret|token)/i,
    label: 'recursive grep for secrets',
  },
  { pattern: /\.bash_history|\.zsh_history|\.python_history|\.node_repl_history/, label: 'shell history files' },
  { pattern: /(curl|wget|fetch)\s+[^\n;|&`]*169\.254\.169\.254/, label: 'cloud metadata endpoint' },
  { pattern: /(curl|wget|fetch)\s+[^\n;|&`]*metadata\.google\.internal/, label: 'GCP metadata endpoint' },
]

export function checkSecretExfilBashGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined
  if (isGuardAcknowledged(args, GUARD_SECRET_EXFIL_BASH)) return undefined

  const matched = DANGEROUS_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))
  if (!matched) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_SECRET_EXFIL_BASH}\` blocked bash command that looks like secret exfiltration: ${matched.label}.`,
      'If this is genuinely intentional and the user explicitly asked for it, retry with',
      `\`${ACKNOWLEDGE_GUARDS}.${GUARD_SECRET_EXFIL_BASH}: true\` in the bash arguments.`,
    ].join(' '),
  }
}
