import { defineCommand } from 'citty'

import { config } from '@/config'
import { isInitialized } from '@/init'
import { createServer } from '@/server'

export const run = defineCommand({
  meta: {
    name: 'run',
    description: 'run the agent in the foreground (container stage)',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to listen on',
      default: String(config.port),
    },
  },
  run({ args }) {
    if (!isInitialized(process.cwd())) {
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const server = createServer({ port: Number(args.port) })
    server.start()
  },
})
