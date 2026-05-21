import { definePlugin } from '@/plugin'

import { createExplorerSubagent } from './explorer'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      explorer: createExplorerSubagent(),
    },
  }),
})
