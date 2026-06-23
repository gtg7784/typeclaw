import { defineCommand } from 'citty'

import { runBackgroundCheck } from '@/update/check'

export const updateCheckCommand = defineCommand({
  meta: {
    name: '_update-check',
    description: 'internal: refresh the typeclaw version cache (do not invoke directly)',
    hidden: true,
  },
  async run() {
    await runBackgroundCheck()
  },
})
