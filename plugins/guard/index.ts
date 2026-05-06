import { definePlugin } from '@/plugin'

import { checkNonWorkspaceWriteGuard } from './policy'

export default definePlugin({
  plugin: async () => ({
    hooks: {
      'tool.before': (event, ctx) =>
        checkNonWorkspaceWriteGuard({ tool: event.tool, args: event.args, agentDir: ctx.agentDir }),
    },
  }),
})
