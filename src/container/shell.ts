import { containerNameFromCwd, dockerCmd, getBun, inspectContainer, type ContainerState } from './shared'

export type ShellPlan = {
  containerName: string
  shell: string
}

export type ShellResult = { ok: true; containerName: string; exitCode: number } | { ok: false; reason: string }

type ShellDeps = {
  inspect?: (name: string) => Promise<ContainerState>
  spawn?: InteractiveSpawn
  resolveDocker?: () => string | null
}

type InteractiveSpawn = (options: {
  cmd: string[]
  cwd: string
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit'
}) => { exited: Promise<number> }

export async function shell(
  { cwd, shell: shellPath = '/bin/bash' }: { cwd: string; shell?: string },
  deps: ShellDeps = {},
): Promise<ShellResult> {
  const bun = getBun()
  const spawn = deps.spawn ?? bun?.spawn
  if (!spawn) return { ok: false, reason: 'bun runtime not available' }

  const { containerName, shell: plannedShell } = planShell(cwd, { shell: shellPath })

  // Resolve docker before inspecting: inspectContainer collapses a missing
  // docker binary into { exists: false }, so deferring this check would
  // surface the misleading "Container … not found" instead of the real
  // "Docker is not installed" on a host without docker on PATH.
  const cmd = dockerCmd(['exec', '-it', containerName, plannedShell], deps.resolveDocker)
  if (cmd === null) {
    return { ok: false, reason: 'Docker is not installed (docker not found on PATH).' }
  }

  try {
    const state = await (deps.inspect ?? inspectContainer)(containerName)
    if (!state.exists) {
      return { ok: false, reason: `Container ${containerName} not found. Run \`typeclaw start\` first.` }
    }
    if (!state.running) {
      return { ok: false, reason: `Container ${containerName} is not running. Run \`typeclaw start\` first.` }
    }

    const proc = spawn({
      cmd,
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    return { ok: true, containerName, exitCode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function planShell(cwd: string, { shell: shellPath = '/bin/bash' }: { shell?: string } = {}): ShellPlan {
  return { containerName: containerNameFromCwd(cwd), shell: shellPath }
}
