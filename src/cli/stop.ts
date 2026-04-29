import { defineCommand } from 'citty'

import { stop } from '@/container'
import { findAgentDir } from '@/init'

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'stop the agent container (host stage)',
  },
  async run() {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const result = await stop({ cwd })

    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }

    if (result.running) {
      console.log(`Stopped ${result.containerName}.`)
    } else {
      console.log(`Container ${result.containerName} is not running.`)
    }
  },
})
