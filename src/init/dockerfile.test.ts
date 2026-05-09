import { describe, expect, test } from 'bun:test'

import { dockerfileSchema } from '@/config/config'

import {
  buildDockerfile,
  CHROME_RUNTIME_APT_PACKAGES_AMD64,
  CURL_IMPERSONATE_PROFILE,
  CURL_IMPERSONATE_SHA256_AMD64,
  CURL_IMPERSONATE_SHA256_ARM64,
  CURL_IMPERSONATE_VERSION,
} from './dockerfile'

// Layer ordering, cache-mount preservation, and on-disk write behavior are
// covered by integration tests in src/init/index.test.ts. This file only
// asserts the toggle-driven content of the rendered Dockerfile string.

// Pulls the package list passed to the main `apt-get install` line so
// assertions are scoped to what actually gets installed and not to
// human-readable comment prose elsewhere in the Dockerfile.
function aptPackages(out: string): string[] {
  const match = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+?) \\\n/)
  if (!match || !match[1]) throw new Error('main apt-get install line not found in Dockerfile output')
  return match[1].split(/\s+/).filter(Boolean)
}

describe('buildDockerfile feature toggles', () => {
  test('defaults: tmux, gh, python (incl. pip/venv/python-is-python3) installed; ffmpeg not installed', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({})))

    expect(pkgs).toContain('tmux')
    expect(pkgs).toContain('gh')
    expect(pkgs).toContain('python3')
    expect(pkgs).toContain('python3-pip')
    expect(pkgs).toContain('python3-venv')
    expect(pkgs).toContain('python-is-python3')
    expect(pkgs).not.toContain('ffmpeg')
  })

  test('default config matches no-arg call (backcompat with the existing default-arg form)', () => {
    expect(buildDockerfile()).toBe(buildDockerfile(dockerfileSchema.parse({})))
  })

  test('tmux: false omits tmux from the apt package list', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ tmux: false })))
    expect(pkgs).not.toContain('tmux')
    expect(pkgs.some((p) => p.startsWith('tmux='))).toBe(false)
  })

  test('python: false omits the entire python bundle', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ python: false })))
    expect(pkgs).not.toContain('python3')
    expect(pkgs).not.toContain('python3-pip')
    expect(pkgs).not.toContain('python3-venv')
    expect(pkgs).not.toContain('python-is-python3')
  })

  test('ffmpeg: true adds ffmpeg to the apt package list', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ ffmpeg: true })))
    expect(pkgs).toContain('ffmpeg')
  })

  test('gh: false omits the gh package and the keyring bootstrap layer (no network roundtrip on rebuild)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ gh: false }))
    const pkgs = aptPackages(out)

    expect(pkgs).not.toContain('gh')
    expect(pkgs.some((p) => p.startsWith('gh='))).toBe(false)
    expect(out).not.toContain('cli.github.com/packages')
    expect(out).not.toContain('githubcli-archive-keyring.gpg')
    expect(out).not.toContain('/etc/apt/sources.list.d/github-cli.list')
  })

  test('string version pins the package: "gh: 2.40.0" → apt-get install gh=2.40.0', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ gh: '2.40.0' })))
    expect(pkgs).toContain('gh=2.40.0')
    expect(pkgs).not.toContain('gh')
  })

  test('string version on tmux pins the package: "tmux: 3.3a-3" → tmux=3.3a-3', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ tmux: '3.3a-3' })))
    expect(pkgs).toContain('tmux=3.3a-3')
  })

  test('string version on ffmpeg installs and pins it', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ ffmpeg: '7:5.1.4-0+deb12u1' })))
    expect(pkgs).toContain('ffmpeg=7:5.1.4-0+deb12u1')
  })

  test('all toggles off: only baseline packages remain (git/ca-certificates/curl/gnupg)', () => {
    const pkgs = aptPackages(
      buildDockerfile(dockerfileSchema.parse({ tmux: false, gh: false, python: false, ffmpeg: false })),
    )
    expect(pkgs).toEqual(['git', 'ca-certificates', 'curl', 'gnupg'])
  })

  test('append lines render after the toggle layers and before ENTRYPOINT', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ ffmpeg: true, append: ['ENV CUSTOM_TOOL=1'] }))

    const ffmpegIdx = out.indexOf('ffmpeg')
    const customIdx = out.indexOf('ENV CUSTOM_TOOL=1')
    const entrypointIdx = out.indexOf('ENTRYPOINT ["bun", "run", "typeclaw"]')

    expect(ffmpegIdx).toBeGreaterThan(-1)
    expect(customIdx).toBeGreaterThan(-1)
    expect(entrypointIdx).toBeGreaterThan(-1)
    expect(ffmpegIdx).toBeLessThan(customIdx)
    expect(customIdx).toBeLessThan(entrypointIdx)
  })

  test('rejects version strings containing whitespace or "=" (apt-injection guard)', () => {
    expect(() => dockerfileSchema.parse({ gh: '2.40.0 curl' })).toThrow(/must not contain whitespace/)
    expect(() => dockerfileSchema.parse({ tmux: '3.3a=evil' })).toThrow(/must not contain whitespace/)
  })
})

function amd64ElseBranchPackages(out: string): string[] {
  const m = out.match(/else \\\n\s+apt-get install -y --no-install-recommends \\\n\s+([^\n]+); \\\n\s+fi/)
  if (!m || !m[1]) throw new Error('amd64 else-branch apt-get install line not found')
  return m[1].split(/\s+/).filter(Boolean)
}

function arm64IfBranchPackages(out: string): string[] {
  const m = out.match(
    /if \[ "\$TARGETARCH" = "arm64" \]; then \\\n\s+apt-get install -y --no-install-recommends ([^\n]+); \\\n\s+else/,
  )
  if (!m || !m[1]) throw new Error('arm64 if-branch apt-get install line not found')
  return m[1].split(/\s+/).filter(Boolean)
}

describe('Chrome runtime deps (amd64)', () => {
  test('amd64 branch installs libglib2.0-0t64 — without it Chrome dies on launch with `libglib-2.0.so.0: cannot open shared object file`', () => {
    expect(amd64ElseBranchPackages(buildDockerfile())).toContain('libglib2.0-0t64')
  })

  test('amd64 branch installs the full Playwright-tested chromium dep set (regression guard against silent drops on agent-browser refactors)', () => {
    const pkgs = amd64ElseBranchPackages(buildDockerfile())
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) expect(pkgs).toContain(p)
  })

  test('amd64 branch does not install fonts (the reported failure is linker-level, not glyph rendering; CJK fonts cost ~50MB+ for no launch impact)', () => {
    const pkgs = amd64ElseBranchPackages(buildDockerfile())
    expect(pkgs.some((p) => p.startsWith('fonts-'))).toBe(false)
  })

  test('arm64 branch installs chromium only — Chrome runtime libs are unnecessary when chromium pulls its own deps via apt', () => {
    const pkgs = arm64IfBranchPackages(buildDockerfile())
    expect(pkgs).toContain('chromium')
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) expect(pkgs).not.toContain(p)
  })

  test('Chrome runtime deps are installed in Layer 2 (before agent-browser CLI install in Layer 4), not only via the Layer 5 --with-deps backstop', () => {
    const out = buildDockerfile()
    const layer2Idx = out.indexOf('libglib2.0-0t64')
    const layer4Idx = out.indexOf('bun install -g agent-browser')
    expect(layer2Idx).toBeGreaterThan(-1)
    expect(layer4Idx).toBeGreaterThan(-1)
    expect(layer2Idx).toBeLessThan(layer4Idx)
  })
})

describe('curl-impersonate layer', () => {
  test('embeds the pinned version in the release URL — bumping a constant is a deliberate, reviewable change, not a moving "latest" target', () => {
    const out = buildDockerfile()
    expect(out).toContain(
      `https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.`,
    )
  })

  test('verifies the tarball sha256 — every reviewer can trace the constant to the layer that enforces it, and a tampered binary would fail the build', () => {
    const out = buildDockerfile()
    expect(out).toContain(CURL_IMPERSONATE_SHA256_AMD64)
    expect(out).toContain(CURL_IMPERSONATE_SHA256_ARM64)
    expect(out).toContain('sha256sum -c -')
  })

  test('branches by TARGETARCH so the same Dockerfile produces correct binaries on amd64 and arm64', () => {
    const out = buildDockerfile()
    expect(out).toMatch(/TARGETARCH.*arm64.*aarch64-linux-gnu/s)
    expect(out).toContain('x86_64-linux-gnu')
  })

  test('extracts to /usr/local/bin (on $PATH) and smoke-tests the wrapper at build time so a missing profile fails the build, not the first search', () => {
    const out = buildDockerfile()
    expect(out).toContain('tar -xzf curl-impersonate.tar.gz -C /usr/local/bin/')
    expect(out).toContain(`/usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version`)
  })

  test('curl-impersonate layer is between Layer 2 (apt) and Layer 4 (agent-browser) so an agent-browser bump does not invalidate it and the apt baseline (curl, ca-certificates, tar) is satisfied', () => {
    const out = buildDockerfile()
    const aptIdx = out.indexOf('libglib2.0-0t64') // marker for Layer 2's else-branch (last apt thing in that block)
    const curlImpersonateIdx = out.indexOf('curl-impersonate.tar.gz')
    const agentBrowserIdx = out.indexOf('bun install -g agent-browser')
    expect(aptIdx).toBeGreaterThan(-1)
    expect(curlImpersonateIdx).toBeGreaterThan(-1)
    expect(agentBrowserIdx).toBeGreaterThan(-1)
    expect(aptIdx).toBeLessThan(curlImpersonateIdx)
    expect(curlImpersonateIdx).toBeLessThan(agentBrowserIdx)
  })
})
