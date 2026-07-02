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

// Which side owns the container control loop. `host` = typeclaw orchestrates
// via local Docker (the only reachable value today). `managed` = an external
// platform (ECS/K8s/…) owns it. The distinction is a deployer concern, not an
// agent-runtime one; see docs/internals for the host/controller split.
export type DeploymentProfile = 'host' | 'managed'

// Single source of truth for the deployment profile. There is no `managed`
// runtime yet, so this always resolves to `host`. When a managed platform
// lands, the trigger (a platform-injected env var, or a config field) is wired
// HERE — one place, not per call site.
export function resolveDeploymentProfile(): DeploymentProfile {
  return 'host'
}

// The controller-axis resolver: maps the deployment profile to its actuator.
// Callers construct their Controller through this instead of `new
// LocalDockerController()` directly. `profile` is injectable for tests;
// production omits it and gets `resolveDeploymentProfile()`.
//
// SCOPE (do not overclaim): this centralizes only the *direct controller
// construction* — the lifecycle CALLS that previously did `new
// LocalDockerController()`. It is NOT yet the single deployment boundary. Two
// host-Docker escape hatches still sit outside it, to be routed when the
// managed controller is actually built:
//   1. Docker preflight (`preflightDocker()`) runs BEFORE the resolver in
//      start/stop/logs/shell/restart and compose, so a managed profile would
//      exit on the host-only check before reaching a managed controller.
//      Fix: resolve profile first, move availability checks inside the host
//      controller path.
//   2. Fleet/status/init paths still use host primitives directly
//      (`resolveDockerBinary` in compose/logs, `inspectContainer` in
//      compose/status, `start`/`stop` deps in init) — probes not on the
//      Controller surface. Route or narrow when managed lands.
export function resolveController(profile: DeploymentProfile = resolveDeploymentProfile()): Controller {
  return profile === 'managed' ? new NoopController() : new LocalDockerController()
}
