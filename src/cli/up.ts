import { defineCommand } from 'citty'

import { config } from '@/config'
import { createServer } from '@/server'

export const up = defineCommand({
  meta: {
    name: 'up',
    description: 'start the agent server',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to listen on',
      default: String(config.port),
    },
  },
  run({ args }) {
    const server = createServer({ port: Number(args.port) })
    server.start()
  },
})
