import { defineCommand } from 'citty'

import {
  composeLogs,
  composePs,
  composeRestart,
  composeStart,
  composeStop,
  type AgentResult,
  type AgentStatus,
} from '@/compose'
import { config } from '@/config'

import { c } from './ui'

const startSub = defineCommand({
  meta: { name: 'start', description: 'start every agent in immediate subdirectories of cwd' },
  args: {
    port: {
      type: 'string',
      description: 'preferred host port for each agent; collisions fall back to ephemeral per-agent',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate each Dockerfile from the template and rebuild',
      default: false,
    },
  },
  async run({ args }) {
    const { agents, results } = await composeStart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    let failed = 0
    for (const r of results) {
      if (r.ok) {
        const verb = r.data.alreadyRunning ? 'already running' : 'started'
        console.log(`${c.green('✔')} ${c.bold(`[${r.name}]`)} ${verb} on host port ${c.cyan(String(r.data.hostPort))}`)
      } else {
        failed++
        console.error(`${c.red('✖')} ${c.bold(`[${r.name}]`)} ${c.red('failed:')} ${r.reason}`)
      }
    }
    summarize(results, 'started', failed)
    if (failed > 0) process.exit(1)
  },
})

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'stop every agent in immediate subdirectories of cwd' },
  async run() {
    const { agents, results } = await composeStop(process.cwd())
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    let failed = 0
    for (const r of results) {
      if (r.ok) {
        if (r.data.running) {
          console.log(`${c.green('✔')} ${c.bold(`[${r.name}]`)} stopped`)
        } else {
          console.log(`${c.dim('○')} ${c.bold(`[${r.name}]`)} ${c.dim('not running')}`)
        }
      } else {
        failed++
        console.error(`${c.red('✖')} ${c.bold(`[${r.name}]`)} ${c.red('failed:')} ${r.reason}`)
      }
    }
    summarize(results, 'stopped', failed)
    if (failed > 0) process.exit(1)
  },
})

const restartSub = defineCommand({
  meta: { name: 'restart', description: 'stop and relaunch every agent in immediate subdirectories of cwd' },
  args: {
    port: {
      type: 'string',
      description: 'preferred host port for each agent; collisions fall back to ephemeral per-agent',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate each Dockerfile from the template and rebuild',
      default: false,
    },
  },
  async run({ args }) {
    const { agents, results } = await composeRestart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    let failed = 0
    for (const r of results) {
      if (r.ok) {
        console.log(
          `${c.green('✔')} ${c.bold(`[${r.name}]`)} restarted on host port ${c.cyan(String(r.data.start.hostPort))}`,
        )
      } else {
        failed++
        console.error(`${c.red('✖')} ${c.bold(`[${r.name}]`)} ${c.red('failed:')} ${r.reason}`)
      }
    }
    summarize(results, 'restarted', failed)
    if (failed > 0) process.exit(1)
  },
})

const psSub = defineCommand({
  meta: { name: 'ps', description: 'show status of every agent in immediate subdirectories of cwd' },
  async run() {
    const { entries } = await composePs(process.cwd())
    if (entries.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const nameW = entries.reduce((w, e) => Math.max(w, e.name.length), 'NAME'.length)
    const containerW = entries.reduce((w, e) => Math.max(w, e.containerName.length), 'CONTAINER'.length)
    console.log(`${c.bold('NAME'.padEnd(nameW))}  ${c.bold('CONTAINER'.padEnd(containerW))}  ${c.bold('STATUS')}`)
    for (const e of entries) {
      console.log(`${e.name.padEnd(nameW)}  ${e.containerName.padEnd(containerW)}  ${colorStatus(e.status)}`)
    }
  },
})

const logsSub = defineCommand({
  meta: { name: 'logs', description: 'multiplex docker logs for every running agent in immediate subdirectories' },
  args: {
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'stream new log output as it arrives',
      default: false,
    },
  },
  async run({ args }) {
    const controller = new AbortController()
    const onSig = (): void => controller.abort()
    process.once('SIGINT', onSig)
    process.once('SIGTERM', onSig)
    try {
      if (args.follow) {
        console.log(c.cyan('Streaming logs for all agents...'))
      } else {
        console.log(c.dim('Showing logs for all agents.'))
      }
      const result = await composeLogs({ rootCwd: process.cwd(), follow: args.follow, signal: controller.signal })
      if (result.agents.length === 0) {
        console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
        return
      }
      if (result.exitCode !== 0) process.exit(result.exitCode)
    } finally {
      process.off('SIGINT', onSig)
      process.off('SIGTERM', onSig)
    }
  },
})

export const composeCommand = defineCommand({
  meta: {
    name: 'compose',
    description: 'orchestrate every typeclaw agent in immediate subdirectories of cwd',
  },
  subCommands: {
    start: startSub,
    stop: stopSub,
    restart: restartSub,
    ps: psSub,
    logs: logsSub,
  },
})

function colorStatus(s: AgentStatus): string {
  if (s === 'running') return c.green('RUNNING')
  if (s === 'stopped') return c.dim('STOPPED')
  return c.yellow('NOT CREATED')
}

function summarize<T>(results: AgentResult<T>[], verb: string, failed: number): void {
  const ok = results.length - failed
  if (failed === 0) {
    console.log(c.green(`${verb} ${ok}/${results.length}`))
  } else {
    console.error(c.red(`${verb} ${ok}/${results.length} (${failed} failed)`))
  }
}
