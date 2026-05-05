import { join } from 'node:path'

import { definePlugin } from '@/plugin'

export default definePlugin({
  plugin: async () => ({
    skillsDirs: [join(import.meta.dir, 'skills')],
  }),
})
