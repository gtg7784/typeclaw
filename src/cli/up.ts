import { defineCommand } from 'citty'

import { config } from '@/config'
import { up } from '@/container'
import { isInitialized } from '@/init'

export const upCommand = defineCommand({
  meta: {
    name: 'up',
    description: 'launch the agent container in the background (host stage)',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to publish on the host',
      default: String(config.port),
    },
  },
  async run({ args }) {
    const cwd = process.cwd()

    if (!isInitialized(cwd)) {
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const result = await up({ cwd, port: Number(args.port) })
    if (!result.ok) {
      console.error(result.reason)
      process.exit(1)
    }

    if (result.built) {
      console.log(`Built image ${result.plan.imageTag}.`)
    }
    console.log(`Container ${result.plan.containerName} started (${result.containerId.slice(0, 12)}).`)
    console.log(`Follow logs:  docker logs -f ${result.plan.containerName}`)
    console.log(`Attach TUI:   typeclaw tui`)
    console.log(`Stop:         typeclaw down`)
  },
})
