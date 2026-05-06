import { definePlugin } from '@/plugin'

import { checkNonWorkspaceWriteGuard, checkSkillAuthoringGuard } from './policy'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'tool.before': async (event, ctx) => {
        const skillResult = await checkSkillAuthoringGuard({
          tool: event.tool,
          args: event.args,
          agentDir: ctx.agentDir,
        })
        if (skillResult) return skillResult
        return checkNonWorkspaceWriteGuard({ tool: event.tool, args: event.args, agentDir: ctx.agentDir })
      },
    },
  }),
})
