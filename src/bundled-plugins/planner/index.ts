import { definePlugin } from '@/plugin'

import { createPlannerSubagent } from './planner'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      planner: createPlannerSubagent(),
    },
  }),
})
