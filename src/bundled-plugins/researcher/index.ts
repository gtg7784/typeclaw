import { definePlugin } from '@/plugin'

import { createResearcherSubagent } from './researcher'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      researcher: createResearcherSubagent(),
    },
  }),
})
