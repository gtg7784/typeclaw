import { defineCommand } from 'citty'

import { config } from '@/config'
import { createTui } from '@/tui'

export const tui = defineCommand({
  meta: {
    name: 'tui',
    description: 'start the tui client',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'initial prompt',
      required: false,
    },
    url: {
      type: 'string',
      description: 'agent websocket url',
      default: `ws://localhost:${config.port}`,
    },
  },
  async run({ args }) {
    const tui = createTui({ url: args.url, initialPrompt: args.prompt })
    await tui.run()
  },
})
