export const GITIGNORE_FILE = '.gitignore'

export function buildGitignore(): string {
  return `.env
.env.local
node_modules/
sessions/
memory/
workspace/tmp/
workspace/downloads/
mounts/
.DS_Store
`
}
