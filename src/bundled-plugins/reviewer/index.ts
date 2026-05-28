import { definePlugin } from '@/plugin'

import { createReviewerSubagent } from './reviewer'

export default definePlugin({
  plugin: async () => ({
    subagents: {
      reviewer: createReviewerSubagent(),
    },
  }),
})
