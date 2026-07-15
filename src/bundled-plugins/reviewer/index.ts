import { definePlugin } from '@/plugin'

import { createReviewerSubagent } from './reviewer'

export default definePlugin({
  plugin: async (ctx) => ({
    subagents: {
      reviewer: createReviewerSubagent({ resolveTokenForRepo: ctx.github.resolveTokenForRepo }),
    },
  }),
})
