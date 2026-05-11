import { defineCommand } from 'citty'

import { stop } from '@/container'
import { findAgentDir } from '@/init'

import { c, spinner } from './ui'

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'stop the agent container (host stage)',
  },
  async run() {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    const s = spinner()
    s.start('Stopping container...')
    const result = await stop({ cwd })

    if (!result.ok) {
      s.error(result.reason)
      process.exit(1)
    }

    if (result.running) {
      s.stop(`Stopped ${c.cyan(result.containerName)}.`)
    } else {
      s.stop(c.dim(`Container ${result.containerName} is not running.`))
    }
  },
})
