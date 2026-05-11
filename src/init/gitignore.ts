import type { GitignoreConfig } from '@/config/config'

export const GITIGNORE_FILE = '.gitignore'

export function buildGitignore(config: GitignoreConfig = { append: [] }): string {
  const customEntries = renderCustomGitignoreEntries(config.append)

  return `${customEntries}# Truly ignored: secrets, runtime junk, the agent's free-write zone, and
# regenerated-on-every-start system files. Never enter git history.
#
# Dockerfile is rewritten from the typeclaw CLI template on every \`typeclaw
# start\` (see src/init/dockerfile.ts), so tracking it would only produce
# noisy "Update Dockerfile" commits whenever the template changes. Treat it
# like node_modules/ — reproducible from source, not part of agent state.
#
# auth.json is the pre-rename name for secrets.json; kept here permanently
# as a safety net so an agent folder cloned from a pre-rename machine never
# stages credentials by accident, even if its agent boot hasn't yet run the
# auth.json -> secrets.json migration.
.env
.env.local
secrets.json
auth.json
node_modules/
packages/*/node_modules/
workspace/
mounts/
Dockerfile
.DS_Store

# System-managed: gitignored by default so the agent never stages them by hand,
# but TypeClaw force-commits them on its own schedule (sessions/ via auto-backup,
# memory/ via the dreaming subagent). Treat them as runtime-owned, not agent-owned.
sessions/
memory/
channels/
`
}

function renderCustomGitignoreEntries(entries: string[]): string {
  if (entries.length === 0) return ''
  return `# Custom entries from typeclaw.json#gitignore.append.
${entries.join('\n')}

`
}
