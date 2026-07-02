import { defineCommand } from 'citty'

import { resolveController } from '@/container'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { requireAgentDir } from './require-agent-dir'
import { c, spinner } from './ui'

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'stop the agent container (host stage)',
  },
  async run() {
    const cwd = requireAgentDir()

    const preflight = await preflightDocker()
    if (!preflight.ok) {
      printDockerGuidance(preflight)
      process.exit(1)
    }

    const s = spinner()
    s.start('Stopping container...')
    const result = await resolveController().stop({ cwd })

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
