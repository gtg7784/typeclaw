import { definePlugin } from '@/plugin'

import { createOperatorSubagent } from './operator'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      operator: createOperatorSubagent(),
    },
  }),
})
