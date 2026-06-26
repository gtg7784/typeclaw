import { describe, expect, test } from 'bun:test'

import {
  classifyConfiguredRuntime,
  detectInstalledDockerApps,
  pickRuntimeToNudge,
  renderDockerUnavailableGuidance,
} from './docker-app'

describe('classifyConfiguredRuntime', () => {
  test('reads orbstack from the daemon-down socket path', () => {
    const detail =
      'failed to connect to the docker API at unix:///home/user/.orbstack/run/docker.sock; check if the daemon is running'
    expect(classifyConfiguredRuntime({}, detail)).toBe('orbstack')
  })

  test('DOCKER_HOST wins over the stderr detail', () => {
    const env = { DOCKER_HOST: 'unix:///home/user/.colima/default/docker.sock' }
    const detail = 'unix:///var/run/orbstack.sock'
    expect(classifyConfiguredRuntime(env, detail)).toBe('colima')
  })

  test('falls back to the detail when DOCKER_HOST names no known runtime', () => {
    const env = { DOCKER_HOST: 'unix:///var/run/docker.sock' }
    const detail = 'unix:///home/user/.orbstack/run/docker.sock'
    expect(classifyConfiguredRuntime(env, detail)).toBe('orbstack')
  })

  test('classifies docker desktop from its desktop-linux socket', () => {
    expect(classifyConfiguredRuntime({}, 'unix:///home/user/.docker/desktop-linux/docker.sock')).toBe('docker-desktop')
  })

  test('classifies colima and podman', () => {
    expect(classifyConfiguredRuntime({}, 'unix:///home/user/.colima/default/docker.sock')).toBe('colima')
    expect(classifyConfiguredRuntime({}, 'unix:///run/user/1000/podman/podman.sock')).toBe('podman')
  })

  test('returns null when no marker is present', () => {
    expect(classifyConfiguredRuntime({}, 'unix:///var/run/docker.sock')).toBeNull()
    expect(classifyConfiguredRuntime({}, undefined)).toBeNull()
  })

  test('classifies Docker Desktop from the Windows named pipe', () => {
    expect(classifyConfiguredRuntime({ DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine' }, undefined)).toBe(
      'docker-desktop',
    )
  })

  test('classifies Podman from the Windows machine pipe', () => {
    expect(classifyConfiguredRuntime({ DOCKER_HOST: 'npipe:////./pipe/podman-machine-default' }, undefined)).toBe(
      'podman',
    )
  })

  test('returns null for the generic Windows docker_engine pipe (no runtime marker)', () => {
    const detail = 'open //./pipe/docker_engine: The system cannot find the file specified.'
    expect(classifyConfiguredRuntime({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, detail)).toBeNull()
  })
})

describe('detectInstalledDockerApps', () => {
  test('finds macOS app bundles', () => {
    const found = detectInstalledDockerApps({
      platform: 'darwin',
      exists: (p) => p === '/Applications/OrbStack.app',
      which: () => null,
    })
    expect(found).toEqual(['orbstack'])
  })

  test('finds both Docker Desktop and OrbStack bundles', () => {
    const found = detectInstalledDockerApps({
      platform: 'darwin',
      exists: () => true,
      which: () => null,
    })
    expect(found).toEqual(['docker-desktop', 'orbstack'])
  })

  test('finds colima and podman on PATH on linux', () => {
    const found = detectInstalledDockerApps({
      platform: 'linux',
      exists: () => false,
      which: (cmd) => (cmd === 'colima' || cmd === 'podman' ? `/usr/bin/${cmd}` : null),
    })
    expect(found).toEqual(['colima', 'podman'])
  })

  test('does not probe macOS app bundles off macOS', () => {
    const found = detectInstalledDockerApps({
      platform: 'linux',
      exists: (p) => p.startsWith('/Applications/'),
      which: () => null,
    })
    expect(found).toEqual([])
  })

  test('finds Docker Desktop on Windows via Program Files', () => {
    const found = detectInstalledDockerApps({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      which: () => null,
    })
    expect(found).toEqual(['docker-desktop'])
  })

  test('finds Podman on Windows via per-user install', () => {
    const found = detectInstalledDockerApps({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      exists: (p) => p === 'C:\\Users\\example\\AppData\\Local\\Programs\\Podman\\podman.exe',
      which: () => null,
    })
    expect(found).toEqual(['podman'])
  })

  test('does not suggest Colima or OrbStack on Windows', () => {
    const found = detectInstalledDockerApps({
      platform: 'win32',
      env: {},
      exists: () => false,
      which: (cmd) => (cmd === 'colima' ? 'C:\\colima.exe' : null),
    })
    expect(found).toEqual([])
  })
})

describe('pickRuntimeToNudge', () => {
  test('configured socket hint beats installed apps', () => {
    const nudge = pickRuntimeToNudge({}, 'unix:///home/user/.orbstack/run/docker.sock', ['docker-desktop'])
    expect(nudge).toBe('orbstack')
  })

  test('falls back to the single installed app', () => {
    expect(pickRuntimeToNudge({}, undefined, ['colima'])).toBe('colima')
  })

  test('returns null when multiple apps installed and no socket hint', () => {
    expect(pickRuntimeToNudge({}, undefined, ['docker-desktop', 'orbstack'])).toBeNull()
  })

  test('returns null when nothing detected', () => {
    expect(pickRuntimeToNudge({}, undefined, [])).toBeNull()
  })
})

describe('renderDockerUnavailableGuidance', () => {
  test('binary-missing renders install links', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'binary-missing', detail: 'docker: command not found in $PATH' },
      { platform: 'darwin', nudge: null, installed: [] },
    )
    expect(result.summary).toBe('Docker is not installed.')
    expect(result.lines.join('\n')).toContain('https://orbstack.dev')
    expect(result.lines.join('\n')).toContain('https://docs.docker.com/get-docker/')
  })

  test('daemon-down with orbstack nudge names the app and gives start steps', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: 'unix:///home/user/.orbstack/run/docker.sock' },
      { platform: 'darwin', nudge: 'orbstack', installed: ['orbstack'] },
    )
    expect(result.summary).toBe('Docker is not running. OrbStack is installed but not started.')
    expect(result.lines.join('\n')).toContain('Open OrbStack')
    expect(result.lines.join('\n')).toContain('orb start')
  })

  test('daemon-down with docker-desktop nudge on macOS', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: '' },
      { platform: 'darwin', nudge: 'docker-desktop', installed: ['docker-desktop'] },
    )
    expect(result.summary).toBe('Docker is not running. Docker Desktop is installed but not started.')
    expect(result.lines.join('\n')).toContain('open -a Docker')
  })

  test('daemon-down with docker-desktop nudge on Windows points at the Start menu', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: 'npipe:////./pipe/docker_engine' },
      { platform: 'win32', nudge: 'docker-desktop', installed: ['docker-desktop'] },
    )
    expect(result.summary).toBe('Docker is not running. Docker Desktop is installed but not started.')
    expect(result.lines.join('\n')).toContain('Start menu')
  })

  test('daemon-down with colima nudge', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: '' },
      { platform: 'darwin', nudge: 'colima', installed: ['colima'] },
    )
    expect(result.lines.join('\n')).toContain('colima start')
  })

  test('daemon-down with multiple apps and no hint lists them generically', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: '' },
      { platform: 'darwin', nudge: null, installed: ['docker-desktop', 'orbstack'] },
    )
    expect(result.summary).toBe('Docker is not running.')
    expect(result.lines.join('\n')).toContain('Docker Desktop, OrbStack')
  })

  test('daemon-down on linux with no app falls back to systemctl', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: '' },
      { platform: 'linux', nudge: null, installed: [] },
    )
    expect(result.lines.join('\n')).toContain('sudo systemctl start docker')
  })

  test('retryHint is appended when provided', () => {
    const result = renderDockerUnavailableGuidance(
      { ok: false, reason: 'daemon-down', detail: '' },
      { platform: 'darwin', nudge: 'orbstack', installed: ['orbstack'], retryHint: 'Then re-run `typeclaw init`.' },
    )
    expect(result.lines[result.lines.length - 1]).toBe('Then re-run `typeclaw init`.')
  })
})
