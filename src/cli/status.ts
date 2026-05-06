import { defineCommand } from 'citty'

import { status as containerStatus, type ContainerStatus } from '@/container'
import { isDaemonReachable, send } from '@/hostd'
import type { StatusResult } from '@/hostd'
import { findAgentDir } from '@/init'

export type HostdStatus =
  | { kind: 'unreachable' }
  | { kind: 'not-registered'; reason: string }
  | { kind: 'registered'; cwd: string; forwardedPorts: number[] }

export type StatusReport = {
  cwd: string
  container: ContainerStatus
  hostd: HostdStatus
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'show the agent container and host daemon status (host stage)',
  },
  async run() {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const container = await containerStatus({ cwd })
    const hostd = await fetchHostdStatus(container.containerName)

    const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
    process.stdout.write(`${formatStatus({ cwd, container, hostd }, { useColor })}\n`)
  },
})

async function fetchHostdStatus(containerName: string): Promise<HostdStatus> {
  if (!(await isDaemonReachable())) return { kind: 'unreachable' }
  const reply = await send({ kind: 'status', containerName })
  if (!reply.ok) return { kind: 'not-registered', reason: reply.reason }
  const result = reply.result as StatusResult | undefined
  if (!result) return { kind: 'not-registered', reason: 'daemon returned empty status' }
  return { kind: 'registered', cwd: result.cwd, forwardedPorts: result.forwardedPorts }
}

export type FormatOptions = { useColor?: boolean }

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

export function formatStatus(report: StatusReport, opts: FormatOptions = {}): string {
  const useColor = opts.useColor ?? false
  const style = useColor ? ANSI : (Object.fromEntries(Object.keys(ANSI).map((k) => [k, ''])) as typeof ANSI)

  const lines: string[] = []
  appendContainerSection(lines, report, style)
  lines.push('')
  appendHostdSection(lines, report, style)
  lines.push('')
  appendForwardingSection(lines, report, style)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function appendContainerSection(lines: string[], report: StatusReport, s: typeof ANSI): void {
  const c = report.container
  lines.push(`${s.bold}Container${s.reset}  ${c.containerName}`)
  lines.push(row('cwd', report.cwd))
  lines.push(row('image', c.imageTag))

  if (c.kind === 'missing') {
    lines.push(row('state', badge(s, 'missing', s.dim)))
    return
  }

  const stateLabel = c.kind === 'running' ? badge(s, 'running', s.green) : badge(s, 'stopped', s.yellow)
  lines.push(row('state', stateLabel))
  lines.push(row('id', shortId(c.containerId)))

  if (c.kind === 'running') {
    const port = c.hostPort === null ? `${s.dim}unknown${s.reset}` : formatHostMapping(c.hostBindAddr, c.hostPort, s)
    lines.push(row('port', port))
  }
}

function appendHostdSection(lines: string[], report: StatusReport, s: typeof ANSI): void {
  lines.push(`${s.bold}Host daemon${s.reset}`)

  switch (report.hostd.kind) {
    case 'unreachable':
      lines.push(row('state', badge(s, 'unreachable', s.dim)))
      lines.push(`  ${s.dim}Daemon is not running. \`typeclaw start\` will spawn one.${s.reset}`)
      return
    case 'not-registered':
      lines.push(row('state', badge(s, 'not registered', s.yellow)))
      lines.push(row('reason', report.hostd.reason))
      return
    case 'registered':
      lines.push(row('state', badge(s, 'registered', s.green)))
      return
  }
}

function appendForwardingSection(lines: string[], report: StatusReport, s: typeof ANSI): void {
  lines.push(`${s.bold}Port forwarding${s.reset}`)

  if (report.hostd.kind !== 'registered') {
    lines.push(`  ${s.dim}requires the host daemon${s.reset}`)
    return
  }

  const ports = report.hostd.forwardedPorts
  if (ports.length === 0) {
    lines.push(`  ${s.dim}no ports currently forwarded${s.reset}`)
    return
  }

  for (const port of [...ports].sort((a, b) => a - b)) {
    lines.push(`  ${s.cyan}127.0.0.1:${port}${s.reset} ${s.dim}->${s.reset} container:${port}`)
  }
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8)}${value}`
}

function badge(s: typeof ANSI, text: string, color: string): string {
  return `${color}${text}${s.reset}`
}

function shortId(id: string): string {
  if (id.length === 0) return '-'
  const trimmed = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
  return trimmed.slice(0, 12)
}

function formatHostMapping(bindAddr: string | null, port: number, s: typeof ANSI): string {
  const bind = bindAddr ?? '127.0.0.1'
  return `${s.cyan}${bind}:${port}${s.reset} ${s.dim}->${s.reset} container:${port}`
}
