import { join } from 'node:path'

import { definePlugin } from '@/plugin'

// Published at boot so the typeclaw-render-pdf skill can `bun run` the bundled
// render.ts without hardcoding a brittle node_modules path. Renaming this path
// requires updating the skill in lockstep (same contract as agent-browser's
// proxy-port hint).
export const RENDER_SCRIPT_HINT_PATH = '/tmp/typeclaw-doc-render-script'

export function renderScriptPath(): string {
  return join(import.meta.dir, 'render.ts')
}

export default definePlugin({
  plugin: async (ctx) => {
    const scriptPath = renderScriptPath()
    try {
      await Bun.write(RENDER_SCRIPT_HINT_PATH, scriptPath)
    } catch (error) {
      ctx.logger.warn(`failed to write ${RENDER_SCRIPT_HINT_PATH}: ${String(error)}`)
    }

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})
