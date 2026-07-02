import { defineCommand } from 'citty'

import { LocalDockerController } from '@/container'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { requireAgentDir } from './require-agent-dir'
import { c, errorLine } from './ui'

export const shellCommand = defineCommand({
  meta: {
    name: 'shell',
    description: 'open an interactive shell in the agent container (host stage)',
  },
  args: {
    shell: {
      type: 'string',
      description: 'shell executable to run inside the container',
      default: '/bin/bash',
    },
  },
  async run({ args }) {
    const cwd = requireAgentDir()

    const preflight = await preflightDocker()
    if (!preflight.ok) {
      printDockerGuidance(preflight)
      process.exit(1)
    }

    console.log(c.cyan(`Attaching ${args.shell} inside the container...`))

    const result = await new LocalDockerController().shell({ cwd, shell: args.shell })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    process.exit(result.exitCode)
  },
})
