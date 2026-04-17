import { basename, resolve } from 'node:path'

export function containerNameFromCwd(cwd: string): string {
  return sanitizeContainerName(basename(resolve(cwd)))
}

export function imageTagFromCwd(cwd: string): string {
  return `typeclaw-${containerNameFromCwd(cwd)}`
}

// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
function sanitizeContainerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (cleaned === '' || !/^[a-zA-Z0-9]/.test(cleaned)) {
    return `tc-${cleaned || 'agent'}`
  }
  return cleaned
}

export async function imageExists(tag: string): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const proc = bun.spawn({
    cmd: ['docker', 'image', 'inspect', tag],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

export async function containerExists(name: string): Promise<boolean> {
  const bun = getBun()
  if (!bun) return false
  const proc = bun.spawn({
    cmd: ['docker', 'ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await proc.exited) !== 0) return false
  const out = (await new Response(proc.stdout).text()).trim()
  return out.split('\n').includes(name)
}

export function getBun(): { spawn: typeof Bun.spawn } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
}
