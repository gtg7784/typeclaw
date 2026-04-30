export const GITIGNORE_FILE = '.gitignore'

export function buildGitignore(): string {
  return `# Truly ignored: secrets, runtime junk, the agent's free-write zone, and
# regenerated-on-every-start system files. Never enter git history.
#
# Dockerfile is rewritten from the typeclaw CLI template on every \`typeclaw
# start\` (see src/init/dockerfile.ts), so tracking it would only produce
# noisy "Update Dockerfile" commits whenever the template changes. Treat it
# like node_modules/ — reproducible from source, not part of agent state.
.env
.env.local
node_modules/
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
