export const GITIGNORE_FILE = '.gitignore'

export function buildGitignore(): string {
  return `.env
.env.local
node_modules/
sessions/
memory/
workspace/
mounts/
.DS_Store
`
}
