import { defineCommand } from 'citty'

import { logs } from '@/container'
import { findAgentDir } from '@/init'

import { c, errorLine } from './ui'

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
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

    if (args.follow) {
      console.log(c.cyan('Streaming container logs...'))
    } else {
      console.log(c.dim('Showing container logs.'))
    }

    const result = await logs({ cwd, follow: args.follow })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    process.exit(result.exitCode)
  },
})
