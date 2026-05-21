import { definePlugin } from '@/plugin'

import { createScoutSubagent } from './scout'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      scout: createScoutSubagent(),
    },
  }),
})
