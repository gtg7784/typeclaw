import { CONTAINER_PORT } from './port'
import { containerNameFromCwd, defaultDockerExec, imageTagFromCwd, type DockerExec } from './shared'

export type ContainerStatus =
  | { kind: 'missing'; containerName: string; imageTag: string }
  | {
      kind: 'stopped'
      containerName: string
      imageTag: string
      containerId: string
      configuredImage: string
    }
  | {
      kind: 'running'
      containerName: string
      imageTag: string
      containerId: string
      configuredImage: string
      hostPort: number | null
      hostBindAddr: string | null
    }

export type StatusOptions = {
  cwd: string
  exec?: DockerExec
}

export async function status({ cwd, exec = defaultDockerExec }: StatusOptions): Promise<ContainerStatus> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const inspect = await exec(['inspect', '--format', '{{.State.Running}}|{{.Id}}|{{.Config.Image}}', containerName])
  if (inspect.exitCode !== 0) {
    return { kind: 'missing', containerName, imageTag }
  }

  const [runningRaw = '', containerId = '', configuredImage = ''] = inspect.stdout.trim().split('|')
  const running = runningRaw.trim() === 'true'

  if (!running) {
    return { kind: 'stopped', containerName, imageTag, containerId, configuredImage }
  }

  const mapping = await queryPortMapping(exec, containerName)
  return {
    kind: 'running',
    containerName,
    imageTag,
    containerId,
    configuredImage,
    hostPort: mapping?.port ?? null,
    hostBindAddr: mapping?.bindAddr ?? null,
  }
}

type PortMapping = { bindAddr: string; port: number }

// Mirrors parseDockerPortOutput in ./port but also keeps the bind address so
// status can show "127.0.0.1:51234 -> 8973" instead of just the host port.
async function queryPortMapping(exec: DockerExec, containerName: string): Promise<PortMapping | null> {
  const result = await exec(['port', containerName, `${CONTAINER_PORT}/tcp`])
  if (result.exitCode !== 0) return null
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const ipv4 = lines.find((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
  const candidate = ipv4 ?? lines[0]!
  const lastColon = candidate.lastIndexOf(':')
  if (lastColon < 0) return null
  const port = Number(candidate.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { bindAddr: candidate.slice(0, lastColon), port }
}
