export const CANONICAL_AGENT_SECRET_DIRS = [
  'workspace/.config/gws',
  'workspace/.agent-messenger',
  '.typeclaw/home',
] as const

export const CANONICAL_AGENT_SECRET_FILES = ['.env', 'secrets.json', 'auth.json'] as const

export const CANONICAL_HOME_SECRET_DIRS = [
  '.ssh',
  '.config/gh',
  '.config/gws',
  '.agent-messenger',
  '.codex',
  '.claude',
] as const

export const CANONICAL_HOME_SECRET_FILES = ['.gitconfig', '.claude.json', '.netrc'] as const
