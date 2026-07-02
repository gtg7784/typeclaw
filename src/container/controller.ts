import { logs, type LogsOptions, type LogsResult } from './logs'
import { containerNameFromCwd, imageTagFromCwd } from './shared'
import { shell, type ShellResult } from './shell'
import { start, type StartOptions, type StartResult } from './start'
import { status, type ContainerStatus, type StatusOptions } from './status'
import { stop, type StopOptions, type StopResult } from './stop'

// The controller role: the external actuator that acts ON a container's
// lifecycle (start/stop/status/logs/shell). Distinct from the host role
// (HostProvider), which the container reaches INTO for durable state.
//
// In the `host` profile typeclaw owns this loop (LocalDockerController shells
// out to Docker). In a `managed` profile a platform (ECS/K8s/…) owns it, so
// typeclaw carries no controller — NoopController makes that absence explicit
// and fail-loud instead of silently shelling out to a Docker that isn't there.
export interface Controller {
  start(options: StartOptions): Promise<StartResult>
  stop(options: StopOptions): Promise<StopResult>
  status(options: StatusOptions): Promise<ContainerStatus>
  logs(options: LogsOptions): Promise<LogsResult>
  shell(options: { cwd: string; shell?: string }): Promise<ShellResult>
}

// Thin adapter over the existing lifecycle functions — no behavior change, it
// just names the actuation surface as an interface so a managed profile can
// substitute NoopController.
export class LocalDockerController implements Controller {
  start(options: StartOptions): Promise<StartResult> {
    return start(options)
  }

  stop(options: StopOptions): Promise<StopResult> {
    return stop(options)
  }

  status(options: StatusOptions): Promise<ContainerStatus> {
    return status(options)
  }

  logs(options: LogsOptions): Promise<LogsResult> {
    return logs(options)
  }

  shell(options: { cwd: string; shell?: string }): Promise<ShellResult> {
    return shell(options)
  }
}

export const CONTROLLER_UNSUPPORTED_REASON =
  'container lifecycle is managed by the platform; typeclaw has no controller in this profile'

// The `managed`-profile controller: the platform owns start/stop/restart, so
// every lifecycle verb is a fail-loud no-op rather than a Docker shell-out.
// status() reports `missing` because typeclaw cannot introspect a container it
// does not orchestrate.
export class NoopController implements Controller {
  async start({ cwd }: StartOptions): Promise<StartResult> {
    return { ok: false, reason: unsupported('start', cwd) }
  }

  async stop({ cwd }: StopOptions): Promise<StopResult> {
    return { ok: false, reason: unsupported('stop', cwd) }
  }

  async status({ cwd }: StatusOptions): Promise<ContainerStatus> {
    return { kind: 'missing', containerName: containerNameFromCwd(cwd), imageTag: imageTagFromCwd(cwd) }
  }

  async logs({ cwd }: LogsOptions): Promise<LogsResult> {
    return { ok: false, reason: unsupported('logs', cwd) }
  }

  async shell({ cwd }: { cwd: string; shell?: string }): Promise<ShellResult> {
    return { ok: false, reason: unsupported('shell', cwd) }
  }
}

function unsupported(verb: string, cwd: string): string {
  return `${verb} unsupported for ${cwd}: ${CONTROLLER_UNSUPPORTED_REASON}`
}
