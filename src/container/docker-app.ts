import { existsSync } from 'node:fs'

import { getBun } from './shared'
import type { DockerAvailability } from './shared'

// Detection + friendly guidance for "Docker is not reachable".
//
// `checkDockerAvailable` (in ./shared) already tells us WHETHER docker works and
// discriminates `binary-missing` (no `docker` on PATH) from `daemon-down` (CLI
// present, daemon refused the connection — the common "Docker Desktop / OrbStack
// installed but not started" case on macOS). What it does NOT do is tell the
// user WHICH runtime to nudge. This module fills that gap: it classifies the
// likely runtime and renders a short, copy-pasteable instruction instead of
// leaking the raw daemon error (which on OrbStack embeds a per-user socket path
// under the user's home dir — noise the user can't act on).
//
// Classification priority (most → least authoritative):
//   1. The configured socket: `DOCKER_HOST` or the socket path inside the raw
//      daemon-down `detail`. An `orbstack` / `docker-desktop` / `colima` /
//      `podman` marker in that path is a high-confidence signal of the runtime
//      the CLI is actually configured to talk to — sharper than guessing from
//      what's installed on disk.
//   2. Installed-app probes (filesystem / PATH). A fallback used only when the
//      socket gives no hint.
//   3. Platform default (generic "start your Docker daemon").

export type DockerApp = 'docker-desktop' | 'orbstack' | 'colima' | 'podman'

export type DockerAppProbes = {
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  which?: (command: string) => string | null
  env?: NodeJS.ProcessEnv
}

const APP_LABELS: Record<DockerApp, string> = {
  'docker-desktop': 'Docker Desktop',
  orbstack: 'OrbStack',
  colima: 'Colima',
  podman: 'Podman',
}

export function dockerAppLabel(app: DockerApp): string {
  return APP_LABELS[app]
}

function defaultWhich(command: string): string | null {
  return getBun()?.which(command) ?? null
}

function resolveProbes(probes: DockerAppProbes): Required<DockerAppProbes> {
  return {
    platform: probes.platform ?? process.platform,
    exists: probes.exists ?? existsSync,
    which: probes.which ?? defaultWhich,
    env: probes.env ?? process.env,
  }
}

// Reads the socket the docker CLI is configured to use and classifies the
// runtime from its path. `DOCKER_HOST` wins (it overrides the default socket);
// otherwise we fall back to the socket path docker printed inside its own
// connection-refused error. Both are matched case-insensitively on the vendor's
// own directory/socket naming, which is ASCII by the tools' own conventions —
// these are protocol/path tokens, not human language, so English matching is
// correct here.
export function classifyConfiguredRuntime(env: NodeJS.ProcessEnv, detail: string | undefined): DockerApp | null {
  // DOCKER_HOST is the runtime the CLI is actually configured to talk to, so it
  // must win outright: classify it alone first and only consult the daemon error
  // detail when DOCKER_HOST names no recognized runtime. Folding both into one
  // haystack would let a stale marker in the error text override an explicit
  // DOCKER_HOST (e.g. DOCKER_HOST=…/.colima/… but the error mentions orbstack).
  return classifyRuntimeMarker(env.DOCKER_HOST) ?? classifyRuntimeMarker(detail)
}

function classifyRuntimeMarker(text: string | undefined): DockerApp | null {
  if (!text) return null
  const lower = text.toLowerCase()
  if (lower.includes('orbstack')) return 'orbstack'
  if (lower.includes('colima')) return 'colima'
  if (lower.includes('podman')) return 'podman'
  // Docker Desktop's user socket lives under `~/.docker/<context>/docker.sock`;
  // the only stable runtime marker in that path is the `desktop`/`desktop-linux`
  // context dir. Checked last so a colima/orbstack context that also sits under
  // `~/.docker` is classified by its own sharper marker first.
  if (lower.includes('desktop')) return 'docker-desktop'
  return null
}

// Probes which Docker runtimes are installed on disk / PATH, most-canonical
// first. macOS app bundles for the GUI runtimes; PATH binaries for the CLI-first
// runtimes (Colima/Podman). The list is deliberately conservative — a false
// "installed" only downgrades the message from runtime-specific to generic, it
// never blocks anything.
export function detectInstalledDockerApps(probes: DockerAppProbes = {}): DockerApp[] {
  const { platform, exists, which } = resolveProbes(probes)
  const found: DockerApp[] = []

  if (platform === 'darwin') {
    if (exists('/Applications/Docker.app')) found.push('docker-desktop')
    if (exists('/Applications/OrbStack.app')) found.push('orbstack')
  }

  if (which('colima') !== null) found.push('colima')
  if (which('podman') !== null) found.push('podman')

  return found
}

// The runtime we should nudge the user to start: configured-socket hint first,
// then the single installed app (if unambiguous), else null (caller emits the
// generic message). When multiple apps are installed and the socket gives no
// hint we deliberately return null rather than guess wrong — the
// "don't claim OrbStack just because the bundle exists" guardrail.
export function pickRuntimeToNudge(
  env: NodeJS.ProcessEnv,
  detail: string | undefined,
  installed: DockerApp[],
): DockerApp | null {
  const configured = classifyConfiguredRuntime(env, detail)
  if (configured !== null) return configured
  if (installed.length === 1) return installed[0] ?? null
  return null
}

function startInstructions(app: DockerApp, platform: NodeJS.Platform): string[] {
  switch (app) {
    case 'orbstack':
      return platform === 'darwin'
        ? ['Open OrbStack (from Applications or Spotlight), then retry.', 'Or from a terminal: `orb start`']
        : ['Start OrbStack, then retry. (`orb start`)']
    case 'docker-desktop':
      if (platform === 'darwin') {
        return [
          'Open Docker Desktop (from Applications or Spotlight), then retry.',
          'Or from a terminal: `open -a Docker`',
        ]
      }
      if (platform === 'win32') {
        return ['Start Docker Desktop from the Start menu, then retry.']
      }
      return ['Start Docker Desktop, then retry.']
    case 'colima':
      return ['Start Colima, then retry: `colima start`']
    case 'podman':
      return ['Start the Podman machine, then retry: `podman machine start`']
  }
}

// Generic "start your daemon" guidance when we can't name the runtime. On Linux
// the daemon is usually systemd-managed; elsewhere it's a GUI app.
function genericStartInstructions(platform: NodeJS.Platform): string[] {
  if (platform === 'linux') {
    return ['Start the Docker daemon, then retry.', 'On most distros: `sudo systemctl start docker`']
  }
  if (platform === 'darwin') {
    return ['Start your Docker runtime (Docker Desktop or OrbStack), then retry.']
  }
  return ['Start your Docker runtime, then retry.']
}

const INSTALL_LINES = [
  'TypeClaw runs every agent inside its own Docker container, so Docker is required.',
  '',
  'Install one of:',
  '  • Docker Desktop — https://docs.docker.com/get-docker/',
  '  • OrbStack (macOS, lighter) — https://orbstack.dev',
]

// Builds the friendly, multi-line guidance shown when Docker is unavailable.
// Pure (no I/O): callers pass the availability result plus pre-probed detection
// facts so this stays trivially testable and reusable by both the CLI preflight
// and `typeclaw init`. `retryHint` lets each caller append its own next step
// (e.g. "re-run `typeclaw init`" vs "retry `typeclaw start`").
export function renderDockerUnavailableGuidance(
  availability: Extract<DockerAvailability, { ok: false }>,
  options: {
    platform: NodeJS.Platform
    nudge: DockerApp | null
    installed: DockerApp[]
    retryHint?: string
  },
): { summary: string; lines: string[] } {
  const { platform, nudge, installed, retryHint } = options

  if (availability.reason === 'binary-missing') {
    const lines = [...INSTALL_LINES]
    if (retryHint) {
      lines.push('', retryHint)
    }
    return { summary: 'Docker is not installed.', lines }
  }

  // daemon-down
  const lines: string[] = []
  let summary: string
  if (nudge !== null) {
    summary = `Docker is not running. ${dockerAppLabel(nudge)} is installed but not started.`
    lines.push(...startInstructions(nudge, platform))
  } else if (installed.length > 1) {
    const names = installed.map(dockerAppLabel).join(', ')
    summary = 'Docker is not running.'
    lines.push(`Detected: ${names}. Start whichever one you use, then retry.`)
  } else {
    summary = 'Docker is installed but the daemon is not reachable.'
    lines.push(...genericStartInstructions(platform))
  }

  if (retryHint) {
    lines.push('', retryHint)
  }
  return { summary, lines }
}
