import { defineCommand } from 'citty'

import { logs } from '@/container'
import { findAgentDir } from '@/init'

export const logCommand = defineCommand({
  meta: {
    name: 'log',
    description: 'show the agent container logs (host stage)',
  },
  args: {
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'stream new log output as it arrives',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    const result = await logs({ cwd, follow: args.follow })
    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }

    process.exit(result.exitCode)
  },
})
