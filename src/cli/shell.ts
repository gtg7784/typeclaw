import { defineCommand } from 'citty'

import { shell } from '@/container'
import { findAgentDir } from '@/init'

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
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    const result = await shell({ cwd, shell: args.shell })
    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }

    process.exit(result.exitCode)
  },
})
