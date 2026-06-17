import { join } from 'node:path'

import { definePlugin } from '@/plugin'

// In-container path of the bundled render script, relative to the agent root
// (the bwrap jail ro-binds /agent, so a low-trust sandboxed `bun run` can read
// it here). typeclaw always installs at node_modules/typeclaw and ships src/ to
// npm, so this path is stable across dev and prod. The skill references the same
// path — keep them in lockstep.
export const RENDER_SCRIPT_AGENT_RELATIVE_PATH = 'node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts'

// In-container path of the bundled themed report library, relative to the agent
// root. The skill tells the agent to copy this next to its markdown and
// `#import "lib.typ"`, because Typst's workspace sandbox only resolves imports
// under the render's working directory. Keep in lockstep with the skill.
export const TEMPLATE_LIB_AGENT_RELATIVE_PATH = 'node_modules/typeclaw/src/bundled-plugins/doc-render/templates/lib.typ'

export function renderScriptPath(): string {
  return join(import.meta.dir, 'render.ts')
}

export function templateLibPath(): string {
  return join(import.meta.dir, 'templates', 'lib.typ')
}

export default definePlugin({
  plugin: async () => ({
    skillsDirs: [join(import.meta.dir, 'skills')],
  }),
})
