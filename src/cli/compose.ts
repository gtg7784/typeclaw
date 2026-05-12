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

import { c, spinner } from './ui'

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
    const board = makeBoard('Starting agents')
    const s = spinner()
    const { agents, results } = await composeStart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'starting')
        } else {
          board.set(s, event.name, formatStartDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'started', failed)
    if (failed > 0) process.exit(1)
  },
})

const stopSub = defineCommand({
  meta: { name: 'stop', description: 'stop every agent in immediate subdirectories of cwd' },
  async run() {
    const board = makeBoard('Stopping agents')
    const s = spinner()
    const { agents, results } = await composeStop({
      rootCwd: process.cwd(),
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'stopping')
        } else {
          board.set(s, event.name, formatStopDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'stopped', failed)
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
    const board = makeBoard('Restarting agents')
    const s = spinner()
    const { agents, results } = await composeRestart({
      rootCwd: process.cwd(),
      preferredHostPort: Number(args.port),
      forceBuild: args.build,
      cliEntry: process.argv[1],
      onProgress: (event) => {
        if (event.kind === 'agent-start') {
          board.add(s, event.name, 'stopping')
        } else if (event.kind === 'agent-stopped') {
          board.set(s, event.name, c.dim('starting...'))
        } else {
          board.set(s, event.name, formatRestartDone(event.result))
        }
      },
    })
    if (agents.length === 0) {
      console.log(c.dim('No typeclaw agents found in immediate subdirectories of cwd.'))
      return
    }
    const failed = results.reduce((n, r) => (r.ok ? n : n + 1), 0)
    board.finish(s, results, 'restarted', failed)
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

// Single clack spinner with a multi-line message body, one line per agent.
// Concurrent clack spinners can't coexist: each one's render loop writes
// cursor.to(0) + erase.down() to process.stdout, so they trample each other.
// Multi-line redraw is safe — clack counts newlines in the previous message
// and walks the cursor up before erasing (see @clack/prompts spinner.ts).
type Board = {
  add: (s: ReturnType<typeof spinner>, name: string, state: string) => void
  set: (s: ReturnType<typeof spinner>, name: string, state: string) => void
  finish: <T>(s: ReturnType<typeof spinner>, results: AgentResult<T>[], verb: string, failed: number) => void
}

function makeBoard(header: string): Board {
  const order: string[] = []
  const states = new Map<string, string>()
  let started = false

  const renderLines = (): string => {
    const width = order.reduce((w, name) => Math.max(w, name.length), 0)
    return order.map((name) => `  ${c.bold(name.padEnd(width))}  ${states.get(name) ?? ''}`).join('\n')
  }

  const paint = (s: ReturnType<typeof spinner>): void => {
    const body = `${header}\n${renderLines()}`
    if (!started) {
      started = true
      s.start(body)
    } else {
      s.message(body)
    }
  }

  return {
    add(s, name, state) {
      order.push(name)
      states.set(name, c.dim(`${state}...`))
      paint(s)
    },
    set(s, name, state) {
      states.set(name, state)
      paint(s)
    },
    finish(s, results, verb, failed) {
      const total = results.length
      const ok = total - failed
      const summary = failed === 0 ? `${verb} ${ok}/${total}` : `${verb} ${ok}/${total} (${failed} failed)`
      const body = `${failed === 0 ? c.green(summary) : c.red(summary)}\n${renderLines()}`
      if (failed === 0) s.stop(body)
      else s.error(body)
    },
  }
}

function formatStartDone<T extends { alreadyRunning?: boolean; hostPort: number }>(result: AgentResult<T>): string {
  if (!result.ok) return `${c.red('✖')} ${c.red('failed:')} ${result.reason}`
  const verb = result.data.alreadyRunning ? 'already running' : 'started'
  return `${c.green('✔')} ${verb} on host port ${c.cyan(String(result.data.hostPort))}`
}

function formatStopDone<T extends { running: boolean }>(result: AgentResult<T>): string {
  if (!result.ok) return `${c.red('✖')} ${c.red('failed:')} ${result.reason}`
  if (result.data.running) return `${c.green('✔')} stopped`
  return `${c.dim('○')} ${c.dim('not running')}`
}

function formatRestartDone<T extends { start: { hostPort: number } }>(result: AgentResult<T>): string {
  if (!result.ok) return `${c.red('✖')} ${c.red('failed:')} ${result.reason}`
  return `${c.green('✔')} restarted on host port ${c.cyan(String(result.data.start.hostPort))}`
}
