import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { start, stop } from '@/container'
import { isInitialized } from '@/init'

export const restartCommand = defineCommand({
  meta: {
    name: 'restart',
    description: 'stop and relaunch the agent container (host stage)',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to publish on the host',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate the Dockerfile from the latest template and rebuild the image',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()

    if (!isInitialized(cwd)) {
      console.error('TypeClaw config file not found. Run `typeclaw init` first.')
      process.exit(1)
    }

    const validated = validateConfig(cwd)
    if (!validated.ok) {
      console.error(validated.reason)
      process.exit(1)
    }

    const stopped = await stop({ cwd })
    if (!stopped.ok) {
      console.error(stopped.reason)
      process.exit(1)
    }
    if (stopped.running) {
      console.log(`Stopped ${stopped.containerName}.`)
    }

    const started = await start({ cwd, port: Number(args.port), forceBuild: args.build })
    if (!started.ok) {
      console.error(started.reason)
      process.exit(1)
    }

    if (started.built) {
      console.log(`Built image ${started.plan.imageTag}.`)
    }
    console.log(`Container ${started.plan.containerName} started (${started.containerId.slice(0, 12)}).`)
    console.log(`Follow logs:  docker logs -f ${started.plan.containerName}`)
    console.log(`Attach TUI:   typeclaw tui`)
    console.log(`Stop:         typeclaw stop`)
  },
})
