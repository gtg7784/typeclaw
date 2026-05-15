import { containerNameFromCwd, inspectContainer, type ContainerState } from './shared'

export type RequireContainerRunningResult = { ok: true; containerName: string } | { ok: false; reason: string }

export type RequireContainerRunningOptions = {
  cwd: string
}

type RequireContainerRunningDeps = {
  inspect?: (name: string) => Promise<ContainerState>
}

// Pre-flight for CLI commands that need to talk to a live agent (tui, reload,
// role claim). Without this, `resolveHostPort` silently falls back to the
// configured port when the container is missing/stopped and the caller hits
// an opaque websocket "Connection refused" or fetch error several frames deep.
// We probe with `inspectContainer` — the same helper `shell` and `start` use —
// and surface the canonical "Run `typeclaw start` first." prose that matches
// `src/container/shell.ts`'s wording.
export async function requireContainerRunning(
  { cwd }: RequireContainerRunningOptions,
  deps: RequireContainerRunningDeps = {},
): Promise<RequireContainerRunningResult> {
  const containerName = containerNameFromCwd(cwd)
  const state = await (deps.inspect ?? inspectContainer)(containerName)
  if (!state.exists) {
    return { ok: false, reason: `Container ${containerName} not found. Run \`typeclaw start\` first.` }
  }
  if (!state.running) {
    return { ok: false, reason: `Container ${containerName} is not running. Run \`typeclaw start\` first.` }
  }
  return { ok: true, containerName }
}
