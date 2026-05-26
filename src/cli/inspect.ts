import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir } from '@/init'
import { runInspectLoop, streamLive, type LiveSourceFactory, type SessionSummary } from '@/inspect'
import { originLabel, shortSessionId } from '@/inspect/label'

import { createEscController } from './inspect-controller'
import { cancel, c, errorLine, isCancel } from './ui'

const ESC_LISTEN_DELAY_MS = 50

export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'observe a session: replay the transcript, then tail live activity (host stage)',
  },
  args: {
    session: {
      type: 'positional',
      description: 'session id or short prefix (omit to pick from a list)',
      required: false,
    },
    filter: {
      type: 'string',
      description:
        'category filter: comma-separated meta/user/assistant/tool/error/done/broadcast/cron-fire; prefix with ! to exclude',
    },
    since: {
      type: 'string',
      description: 'only events newer than this (forms: 30s, 5m, 1h, 7d)',
    },
    json: {
      type: 'boolean',
      description: 'emit one JSON event per line; requires an explicit session id',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const color = useColor()
    const sessionArg = typeof args.session === 'string' ? args.session : undefined
    const filterArg = typeof args.filter === 'string' ? args.filter : undefined
    const sinceArg = typeof args.since === 'string' ? args.since : undefined

    const isJson = args.json === true
    const liveSource = isJson ? undefined : await buildLiveSource(cwd)
    const signal = installSigintAbort()
    const escListener = isJson ? null : createEscListener()
    const liveHint = escListener === null ? undefined : escHintLine(color)

    const result = await runInspectLoop({
      agentDir: cwd,
      ...(sessionArg !== undefined ? { sessionIdOrPrefix: sessionArg } : {}),
      ...(filterArg !== undefined ? { filter: filterArg } : {}),
      ...(sinceArg !== undefined ? { since: sinceArg } : {}),
      json: isJson,
      color,
      selectSession: (sessions, selectOpts) => {
        escListener?.pause()
        return clackSelect(sessions, selectOpts?.initialSessionId).finally(() => {
          escListener?.resume()
        })
      },
      ...(liveSource !== undefined ? { liveSource } : {}),
      signal,
      newEscSignal: () => {
        if (escListener === null) return new AbortController().signal
        return escListener.armForStream()
      },
      ...(liveHint !== undefined ? { liveHint } : {}),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    })

    escListener?.stop()

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.reason)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

async function buildLiveSource(cwd: string): Promise<LiveSourceFactory | undefined> {
  const precheck = await requireContainerRunning({ cwd })
  if (!precheck.ok) {
    process.stderr.write(`${c.yellow('⚠')} ${precheck.reason}; tailing live events disabled\n`)
    return undefined
  }
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const baseUrl = new URL(`ws://127.0.0.1:${port}/inspect`)
  if (token !== null) baseUrl.searchParams.set('token', token)
  const url = baseUrl.toString()
  return ({ sessionId, sinceMs, signal, onSubscribed }) =>
    streamLive({
      url,
      sessionId,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(onSubscribed !== undefined ? { onSubscribed } : {}),
    })
}

function installSigintAbort(): AbortSignal {
  const ctrl = new AbortController()
  const onSig = (): void => {
    ctrl.abort()
  }
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)
  return ctrl.signal
}

type EscListener = {
  armForStream: () => AbortSignal
  pause: () => void
  resume: () => void
  stop: () => void
}

function createEscListener(): EscListener | null {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return null

  const ctrl = createEscController({ debounceMs: ESC_LISTEN_DELAY_MS })
  let active = false

  const onData = (chunk: Buffer): void => {
    const { sigint } = ctrl.onChunk(chunk)
    if (sigint) process.kill(process.pid, 'SIGINT')
  }

  const start = (): void => {
    if (active) return
    active = true
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  }
  const stop = (): void => {
    if (!active) return
    active = false
    stdin.off('data', onData)
    try {
      stdin.setRawMode(false)
    } catch {
      /* terminal already torn down */
    }
    stdin.pause()
    ctrl.clearPending()
  }

  return {
    armForStream: () => {
      const signal = ctrl.armForStream()
      start()
      return signal
    },
    pause: () => {
      stop()
    },
    resume: () => {
      // Resume the listener WITHOUT replacing the AbortController.
      // The signal returned by armForStream() is held by the live source
      // through streamSession's combinedSignal; replacing the controller
      // here would orphan that signal so a subsequent ESC press could
      // not abort the live tail.
      start()
    },
    stop: () => {
      ctrl.dispose()
      stop()
    },
  }
}

function escHintLine(color: boolean): string {
  const text = '(press esc to return to session list)'
  return color ? `\u001b[2m${text}\u001b[0m` : text
}

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

async function clackSelect(
  sessions: SessionSummary[],
  initialSessionId: string | undefined,
): Promise<SessionSummary | null> {
  const { select } = await import('@clack/prompts')
  const preferred =
    initialSessionId !== undefined && sessions.some((s) => s.sessionId === initialSessionId)
      ? initialSessionId
      : sessions[0]?.sessionId
  const picked = await select<string>({
    message: `Pick a session to inspect (showing ${sessions.length})`,
    options: sessions.map((s) => ({
      value: s.sessionId,
      label: formatRowLabel(s),
      ...(s.firstPrompt !== null ? { hint: truncate(s.firstPrompt, 60) } : { hint: '(no prompt)' }),
    })),
    initialValue: preferred,
  })
  if (isCancel(picked)) {
    cancel('Cancelled.')
    return null
  }
  return sessions.find((s) => s.sessionId === picked) ?? null
}

function formatRowLabel(s: SessionSummary): string {
  const id = shortSessionId(s.sessionId)
  const label = s.origin === null ? '(unknown origin)' : originLabel(s.origin)
  const when = formatRelative(s.mtimeMs)
  return `${c.cyan(id)}  ${label}  ${c.dim(when)}`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function truncate(text: string, max: number): string {
  const oneline = text.replace(/\s+/g, ' ').trim()
  if (oneline.length <= max) return oneline
  return `${oneline.slice(0, max)}…`
}
