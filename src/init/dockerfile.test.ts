import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dockerfileSchema } from '@/config/config'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'
import {
  buildBaseDockerfile,
  buildDockerfile,
  buildEntrypointShim,
  CHROME_RUNTIME_APT_PACKAGES_AMD64,
  CLOUDFLARED_RELEASE_URL_BASE,
  CLOUDFLARED_VERSION,
  CURL_IMPERSONATE_PROFILE,
  CURL_IMPERSONATE_SHA256_AMD64,
  CURL_IMPERSONATE_SHA256_ARM64,
  CURL_IMPERSONATE_VERSION,
  NETWORK_BLOCK_IPV4_NETS,
  NETWORK_BLOCK_IPV6_NETS,
  TYPECLAW_ENTRYPOINT_PATH,
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

  test('all toggles off: only baseline packages remain (egress-shim deps ship unconditionally; xvfb is a toggle, off here)', () => {
    const pkgs = aptPackages(
      buildDockerfile(
        dockerfileSchema.parse({
          tmux: false,
          gh: false,
          python: false,
          ffmpeg: false,
          cjkFonts: false,
          xvfb: false,
        }),
      ),
    )
    expect(pkgs).toEqual(['git', 'ca-certificates', 'curl', 'gnupg', 'iptables', 'util-linux'])
  })

  test('xvfb: true (the default) adds xvfb to the toggle apt package list, after the baseline packages', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({})))
    expect(pkgs).toContain('xvfb')
    expect(pkgs.indexOf('xvfb')).toBeGreaterThan(pkgs.indexOf('util-linux'))
  })

  test('xvfb: false omits xvfb from the apt package list (opt-out)', () => {
    const pkgs = aptPackages(buildDockerfile(dockerfileSchema.parse({ xvfb: false })))
    expect(pkgs).not.toContain('xvfb')
  })

  test('append lines render after the toggle layers and before ENTRYPOINT', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ ffmpeg: true, append: ['ENV CUSTOM_TOOL=1'] }))

    const ffmpegIdx = out.indexOf('ffmpeg')
    const customIdx = out.indexOf('ENV CUSTOM_TOOL=1')
    const entrypointIdx = out.indexOf(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)

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

describe('claudeCode toggle', () => {
  test('defaults to false (the install layer is opt-in via the typeclaw-claude-code skill)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}))
    expect(out).not.toContain('claude.ai/install.sh')
  })

  test('claudeCode: false omits the install layer entirely', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: false }))
    expect(out).not.toContain('claude.ai/install.sh')
  })

  test('claudeCode: true emits the curl-piped install layer in the inline (dev) form', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    expect(out).toContain('RUN curl -fsSL https://claude.ai/install.sh | bash')
  })

  test('claudeCode: true emits the install layer in the versioned (base-image) form too — drift guard', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }), { baseImageVersion: '0.1.1' })
    expect(out).toContain('RUN curl -fsSL https://claude.ai/install.sh | bash')
  })

  test('install layer renders before the entrypoint shim so the shim is always the final RUN', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ claudeCode: true }))
    const claudeIdx = out.indexOf('claude.ai/install.sh')
    const shimIdx = out.indexOf(TYPECLAW_ENTRYPOINT_PATH)
    expect(claudeIdx).toBeGreaterThan(-1)
    expect(shimIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeLessThan(shimIdx)
  })

  test('install layer is rejected by parse: claudeCode does not accept string version pins (the upstream installer is not a versioned apt package)', () => {
    expect(() => dockerfileSchema.parse({ claudeCode: '1.2.3' })).toThrow()
  })

  test('base Dockerfile never embeds the claude install — toggle-driven layers stay in the per-agent file so changing the flag does not rebuild the base image', () => {
    expect(buildBaseDockerfile()).not.toContain('claude.ai/install.sh')
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

  test('amd64 else-branch (Chrome runtime libs) does not install fonts — fonts are not a launch-time linker concern, they layer in via the cjkFonts toggle', () => {
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

describe('cjkFonts toggle', () => {
  test('default is true: fonts-noto-cjk lands in the main apt-get install line so CJK glyphs render in Chromium screenshots/PDFs out of the box', () => {
    const pkgs = aptPackages(buildDockerfile())
    expect(pkgs).toContain('fonts-noto-cjk')
  })

  test('cjkFonts: false omits fonts-noto-cjk entirely — opt-out actually saves the ~56MB layer', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: false }))
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test('cjkFonts default lives on the toggle apt layer, not the Chrome-runtime-libs branch (so opt-out works without re-architecting the launch-deps invariant)', () => {
    const out = buildDockerfile()
    expect(aptPackages(out)).toContain('fonts-noto-cjk')
    expect(amd64ElseBranchPackages(out)).not.toContain('fonts-noto-cjk')
    expect(arm64IfBranchPackages(out)).not.toContain('fonts-noto-cjk')
  })

  test('versioned per-agent Dockerfile (base-image-pinning): cjkFonts: true emits fonts-noto-cjk in the per-agent toggle layer (NOT baked into the base image, so opt-out is honored regardless of base-image vintage)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: true }), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    const pkgs = aptInstallMatch![1]!.split(/\s+/).filter(Boolean)
    expect(pkgs).toContain('fonts-noto-cjk')
  })

  test('versioned per-agent Dockerfile (base-image-pinning): cjkFonts: false does not add fonts-noto-cjk on top of the base image', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cjkFonts: false }), { baseImageVersion: '0.1.1' })
    expect(out).not.toContain('fonts-noto-cjk')
  })

  test('base Dockerfile does NOT install fonts-noto-cjk — fonts ride the per-agent toggle apt layer, never the shared base image, so cjkFonts: false truly skips the ~56MB even on GHCR-base agents', () => {
    expect(buildBaseDockerfile()).not.toContain('fonts-noto-cjk')
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

describe('cloudflared layer', () => {
  test('cloudflared: true emits the pinned cloudflared download layer', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: true }))

    expect(out).toContain(`${CLOUDFLARED_RELEASE_URL_BASE}/${CLOUDFLARED_VERSION}/cloudflared-linux-`)
    expect(out).toContain('/usr/local/bin/cloudflared --version')
  })

  test('cloudflared: false omits the layer entirely', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: false }))

    expect(out).not.toContain('cloudflared-linux-')
    expect(out).not.toContain('/usr/local/bin/cloudflared --version')
  })

  test('default config includes the cloudflared layer (default flipped to true so cloudflare-quick tunnels work out of the box)', () => {
    const out = buildDockerfile()

    expect(out).toContain(`${CLOUDFLARED_RELEASE_URL_BASE}/${CLOUDFLARED_VERSION}/cloudflared-linux-`)
    expect(out).toContain('/usr/local/bin/cloudflared --version')
  })

  test('cloudflared layer appears after curl-impersonate and before the entrypoint shim', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ cloudflared: true }))
    const curlIdx = out.indexOf('curl-impersonate.tar.gz')
    const cloudflaredIdx = out.indexOf('cloudflared-linux-')
    const entrypointIdx = out.indexOf(`base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)

    expect(curlIdx).toBeGreaterThan(-1)
    expect(cloudflaredIdx).toBeGreaterThan(-1)
    expect(entrypointIdx).toBeGreaterThan(-1)
    expect(curlIdx).toBeLessThan(cloudflaredIdx)
    expect(cloudflaredIdx).toBeLessThan(entrypointIdx)
  })
})

// The base image (ghcr.io/typeclaw/typeclaw-base) and the per-agent
// Dockerfile (emitted by `typeclaw start`) MUST agree on every toolchain
// version, library path, and binary location. When they don't, the
// per-agent Dockerfile's eventual FROM line inherits a base whose contents
// don't match what buildDockerfile() assumes, and the agent fails at
// runtime in subtle ways: websearch silently regresses when curl-impersonate
// is the wrong version, Chrome fails to launch when a runtime lib is
// missing, etc. These tests lock the structural invariant that both
// outputs share the same toolchain pins, install paths, and Layer 0 cache
// trick — so a new toolchain pin in buildDockerfile() that does not also
// appear in buildBaseDockerfile() fails CI.
describe('base ↔ per-agent Dockerfile drift guard', () => {
  test('base Dockerfile pins the same curl-impersonate version, sha256s, and profile as the per-agent Dockerfile', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain(CURL_IMPERSONATE_VERSION)
    expect(base).toContain(CURL_IMPERSONATE_SHA256_AMD64)
    expect(base).toContain(CURL_IMPERSONATE_SHA256_ARM64)
    expect(base).toContain(`/usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version`)
  })

  test('base Dockerfile installs the full Playwright-tested chromium runtime dep set on amd64 — same list the per-agent Dockerfile depends on Chrome to find at launch time', () => {
    const base = buildBaseDockerfile()
    for (const p of CHROME_RUNTIME_APT_PACKAGES_AMD64) {
      expect(base).toContain(p)
    }
  })

  test('base Dockerfile installs the agent-browser CLI to the same global location the per-agent Dockerfile expects', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('bun install -g agent-browser')
  })

  test('base Dockerfile downloads Chrome for Testing on amd64 — without it the per-agent image would FROM a base that lacks the browser binary and `agent-browser install` would have to redo it', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('agent-browser install --with-deps')
  })

  test('base Dockerfile points agent-browser at the apt chromium on arm64 (no Chrome for Testing download path on that arch)', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('/root/.agent-browser/config.json')
    expect(base).toContain('/usr/bin/chromium')
  })

  test('base Dockerfile omits gh keyring bootstrap — toggle-driven layers live in the per-agent Dockerfile so typeclaw.json toggles do not force a base-image rebuild', () => {
    const base = buildBaseDockerfile()
    expect(base).not.toContain('cli.github.com/packages')
    expect(base).not.toContain('githubcli-archive-keyring.gpg')
  })

  test('base Dockerfile main apt-get install line installs only the baseline packages (no gh/python/tmux/ffmpeg/xvfb — xvfb is a toggle layered onto the base by the per-agent Dockerfile)', () => {
    const base = buildBaseDockerfile()
    const match = base.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+?) \\\n/)
    if (!match || !match[1]) throw new Error('main apt-get install line not found in base Dockerfile')
    const pkgs = match[1].split(/\s+/).filter(Boolean)
    expect(pkgs).toEqual(['git', 'ca-certificates', 'curl', 'gnupg', 'iptables', 'util-linux'])
  })

  test('base Dockerfile uses the same BuildKit syntax pragma and base image as the per-agent Dockerfile so layer caching across the two is possible', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('# syntax=docker/dockerfile:1.7')
    expect(base).toContain('FROM oven/bun:1-slim')
    expect(base).toContain('WORKDIR /agent')
  })

  test('base Dockerfile preserves the apt-keep-cache trick from Layer 0 — without it, cache mounts on /var/cache/apt are useless', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('docker-clean')
    expect(base).toContain('Keep-Downloaded-Packages "true"')
  })
})

// Count of RUN blocks that match a marker pattern. Used by the versioned-
// form tests to assert structural absence of heavy layers without coupling
// to specific package names or comment prose.
function countRunBlocksMatching(out: string, pattern: RegExp): number {
  return out.split(/\n(?=RUN )/).filter((block) => block.startsWith('RUN ') && pattern.test(block)).length
}

describe('versioned per-agent Dockerfile (base-image-pinning)', () => {
  test('FROMs ghcr.io/typeclaw/typeclaw-base at the requested version', () => {
    // given: a versioned build option
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })

    // then: the FROM line pins the GHCR base image, not oven/bun
    expect(out).toContain(`FROM ${GHCR_BASE_IMAGE_REPO}:0.1.1`)
    expect(out).not.toContain('FROM oven/bun:1-slim')
  })

  test('FROM tag is interpolated verbatim with no coercion', () => {
    // given: an arbitrary version string (the function must not normalize, parse, or rewrite it)
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '9.99.99-beta.1' })

    // then: the tag passes through unchanged
    expect(out).toContain(`FROM ${GHCR_BASE_IMAGE_REPO}:9.99.99-beta.1`)
  })

  test('omits the heavy stack RUN blocks — those layers live in the base image', () => {
    // given: a versioned build with default toggles
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })

    // then: no curl-impersonate download, no agent-browser install, no Chrome download
    // (cloudflared is intentionally NOT part of the prebuilt base image because it is
    // gated by docker.file.cloudflared; the per-agent versioned Dockerfile still emits
    // it when the toggle is on, so this regex deliberately excludes its sha256sum line)
    expect(countRunBlocksMatching(out, /curl-impersonate/)).toBe(0)
    expect(countRunBlocksMatching(out, /bun install -g agent-browser/)).toBe(0)
    expect(countRunBlocksMatching(out, /agent-browser install --with-deps/)).toBe(0)
    expect(countRunBlocksMatching(out, /apt-keep-cache|Keep-Downloaded-Packages/)).toBe(0)
    // and: no apt-get install line that also installs baseline packages
    expect(out).not.toMatch(/apt-get install[^\n]*\bgit\b[^\n]*\bca-certificates\b/)
  })

  test('with all toggles off: emits no apt install RUN block at all (zero-cost per-agent rebuild)', () => {
    // given: every toggle disabled, so no per-agent apt work is needed
    const out = buildDockerfile(
      dockerfileSchema.parse({
        tmux: false,
        gh: false,
        python: false,
        ffmpeg: false,
        cjkFonts: false,
        xvfb: false,
      }),
      {
        baseImageVersion: '0.1.1',
      },
    )

    // then: zero apt-get blocks
    expect(countRunBlocksMatching(out, /apt-get/)).toBe(0)
  })

  test('with toggles on: emits exactly one apt install RUN block containing only toggle packages', () => {
    // given: gh + tmux enabled, python + ffmpeg + cjkFonts + xvfb disabled
    const out = buildDockerfile(
      dockerfileSchema.parse({
        gh: true,
        tmux: true,
        python: false,
        ffmpeg: false,
        cjkFonts: false,
        xvfb: false,
      }),
      {
        baseImageVersion: '0.1.1',
      },
    )

    // then: there's an apt install line with exactly the toggle packages
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    const pkgs = aptInstallMatch![1]!.split(/\s+/).filter(Boolean)
    expect(pkgs).toEqual(['gh', 'tmux'])
  })

  test('versioned per-agent Dockerfile: xvfb: true (default) emits xvfb in the per-agent toggle layer so older base images without it still get a working virtual display', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    expect(aptInstallMatch![1]!.split(/\s+/).filter(Boolean)).toContain('xvfb')
  })

  test('versioned per-agent Dockerfile: xvfb: false omits xvfb on top of the base image (opt-out honored regardless of base-image vintage)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({ xvfb: false }), { baseImageVersion: '0.1.1' })
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    if (aptInstallMatch !== null) {
      expect(aptInstallMatch[1]!.split(/\s+/).filter(Boolean)).not.toContain('xvfb')
    }
  })

  test('keeps gh keyring bootstrap when gh is enabled (per-agent toggle, not base-image content)', () => {
    // when: gh enabled
    const out = buildDockerfile(dockerfileSchema.parse({ gh: true }), { baseImageVersion: '0.1.1' })

    // then: the keyring layer is present
    expect(out).toMatch(/cli\.github\.com\/packages\/githubcli-archive-keyring\.gpg/)
  })

  test('drops gh keyring bootstrap when gh is disabled', () => {
    // when: gh disabled
    const out = buildDockerfile(dockerfileSchema.parse({ gh: false }), { baseImageVersion: '0.1.1' })

    // then: no keyring fetch
    expect(out).not.toMatch(/cli\.github\.com\/packages/)
  })

  test('keeps the per-agent tail: ENV vars, append lines, ENTRYPOINT, CMD', () => {
    // given: a custom append line
    const out = buildDockerfile(dockerfileSchema.parse({ append: ['ENV CUSTOM_TOOL=1'] }), {
      baseImageVersion: '0.1.1',
    })

    // then: every per-agent tail directive is present, in order
    expect(out).toContain('ENV NODE_ENV=production')
    expect(out).toContain('ENV AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger')
    expect(out).toContain('ENV CUSTOM_TOOL=1')
    expect(out).toContain(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)
    expect(out).toContain('CMD ["run"]')
    expect(out.indexOf('ENV CUSTOM_TOOL=1')).toBeLessThan(out.indexOf('ENTRYPOINT'))
  })

  test('emits the entrypoint shim install layer even though the base image already carries it (guards against older base images and shim source edits)', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(out).toContain(`echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out).toContain(`chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out.indexOf(TYPECLAW_ENTRYPOINT_PATH)).toBeLessThan(out.indexOf('ENTRYPOINT'))
  })

  test('explicit baseImageVersion: null is identical to the default (inline) form', () => {
    // when: caller explicitly passes null vs omits the option
    const inlineExplicit = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: null })
    const inlineDefault = buildDockerfile(dockerfileSchema.parse({}))

    // then: outputs are byte-identical and use oven/bun (not GHCR base)
    expect(inlineExplicit).toBe(inlineDefault)
    expect(inlineExplicit).toContain('FROM oven/bun:1-slim')
    expect(inlineExplicit).not.toContain(GHCR_BASE_IMAGE_REPO)
  })
})

describe('network egress entrypoint shim', () => {
  test('off-switch path (network.blockInternal=false) installs no iptables rules and execs the agent directly (after start_xvfb runs to set DISPLAY)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1"')
    expect(shim).toMatch(/!= "1" \];? then\s+start_xvfb\s+exec bun run typeclaw "\$@"/)
  })

  test('shim self-heals on Xvfb presence: spawns Xvfb directly (not xvfb-run, which hangs as PID 1) and exports DISPLAY', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('command -v Xvfb')
    expect(shim).toContain('Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp')
    expect(shim).toContain('export DISPLAY=:99')
    // Strip the rationale-block comment lines that explain why we avoid
    // xvfb-run, then assert it is not invoked anywhere in executable code.
    const executable = shim
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable).not.toContain('xvfb-run')
  })

  test('shim waits for Xvfb socket to exist before exec-ing the agent (avoids "cannot open display" race)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('/tmp/.X11-unix/X99')
  })

  test('installs a REJECT rule for every IPv4 network in NETWORK_BLOCK_IPV4_NETS', () => {
    const shim = buildEntrypointShim()
    for (const net of NETWORK_BLOCK_IPV4_NETS) {
      expect(shim).toContain(`iptables -A OUTPUT -d ${net} -j REJECT --reject-with icmp-port-unreachable`)
    }
  })

  test('installs a REJECT rule for every IPv6 network in NETWORK_BLOCK_IPV6_NETS', () => {
    const shim = buildEntrypointShim()
    for (const net of NETWORK_BLOCK_IPV6_NETS) {
      expect(shim).toContain(`ip6tables -A OUTPUT -d ${net} -j REJECT --reject-with icmp6-port-unreachable`)
    }
  })

  test('blocks the canonical home-router scenario (192.168.0.0/16) and the AWS IMDS range (169.254.0.0/16)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('192.168.0.0/16')
    expect(shim).toContain('169.254.0.0/16')
  })

  test('allows loopback traffic explicitly so dev-server dogfooding still works', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('iptables -A OUTPUT -o lo -j ACCEPT')
    expect(shim).toContain('ip6tables -A OUTPUT -o lo -j ACCEPT')
  })

  test('allows ESTABLISHED,RELATED return traffic so Docker port-forward replies survive the RFC1918 REJECT', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
    expect(shim).toContain('ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
  })

  test('ESTABLISHED,RELATED ACCEPT runs before the RFC1918 REJECTs (first-match-wins ordering)', () => {
    const shim = buildEntrypointShim()
    const ctstateIdx = shim.indexOf('--ctstate ESTABLISHED,RELATED -j ACCEPT')
    const rejectIdx = shim.indexOf('192.168.0.0/16 -j REJECT')
    expect(ctstateIdx).toBeGreaterThan(-1)
    expect(rejectIdx).toBeGreaterThan(-1)
    expect(ctstateIdx).toBeLessThan(rejectIdx)
  })

  test('re-allows hostd narrowly: TCP, single port parsed from TYPECLAW_HOSTD_URL, IPv4-only', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('TYPECLAW_HOSTD_URL')
    expect(shim).toContain('getent ahostsv4 host.docker.internal')
    expect(shim).toContain('iptables -A OUTPUT -p tcp -d "$host_gw_ip" --dport "$hostd_port" -j ACCEPT')
  })

  test('does NOT ACCEPT the host gateway IP wholesale (closes the host-port-probing hole)', () => {
    const shim = buildEntrypointShim()
    expect(shim).not.toContain('iptables -A OUTPUT -d "$host_gw_ip" -j ACCEPT')
  })

  test('uses ahostsv4 so a resolver that prefers AAAA cannot crash the shim under set -e', () => {
    const shim = buildEntrypointShim()
    expect(shim).not.toMatch(/getent hosts host\.docker\.internal/)
    expect(shim).toContain('getent ahostsv4')
  })

  test('hostd carve-out is skipped when TYPECLAW_HOSTD_URL is unset (no ACCEPT rule installed at all)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/if \[ -n "\$\{TYPECLAW_HOSTD_URL:-\}" \]; then/)
    expect(shim).toMatch(/if \[ -n "\$\{hostd_port:-\}" \]; then/)
  })

  test('drops NET_ADMIN from bounding+inheritable+ambient sets before exec-ing (matches setpriv(1) warning)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain(
      'exec setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin -- bun run typeclaw "$@"',
    )
  })

  test('start_xvfb is called before each exec (off-path immediately before exec bun; on-path after iptables, before exec setpriv) so DISPLAY is exported before the agent inherits the env', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('export DISPLAY=:99')

    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    expect(offBranchEnd).toBeGreaterThan(-1)
    const offBranch = shim.slice(0, offBranchEnd)
    const offStartXvfbIdx = offBranch.lastIndexOf('start_xvfb\n')
    const offExecIdx = offBranch.search(/exec bun run typeclaw "\$@"/)
    expect(offStartXvfbIdx).toBeGreaterThan(-1)
    expect(offExecIdx).toBeGreaterThan(offStartXvfbIdx)

    const onBranch = shim.slice(offBranchEnd)
    const lastIptablesIdx = onBranch.lastIndexOf('iptables -A OUTPUT')
    const onStartXvfbIdx = onBranch.lastIndexOf('start_xvfb\n')
    const onExecIdx = onBranch.indexOf('exec setpriv')
    expect(lastIptablesIdx).toBeGreaterThan(-1)
    expect(onStartXvfbIdx).toBeGreaterThan(lastIptablesIdx)
    expect(onExecIdx).toBeGreaterThan(onStartXvfbIdx)
  })

  test('Xvfb runs under the same setpriv capability-drop as the agent so it never holds NET_ADMIN on the network-block path', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(
      /setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin \\\s+-- Xvfb :99/,
    )
  })

  test('Xvfb startup failure is loud: helper polls liveness with kill -0 and exits non-zero with a stderr line on early exit or socket timeout', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('kill -0 "$xvfb_pid"')
    expect(shim).toMatch(/typeclaw-entrypoint: Xvfb exited immediately[^\n]+\n[^\n]+exit 1/)
    expect(shim).toMatch(/typeclaw-entrypoint: Xvfb did not create \/tmp\/\.X11-unix\/X99[^\n]+\n[^\n]+exit 1/)
  })

  test('runs `set -eu` so an iptables failure brings PID 1 down (fail closed)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/^#!\/bin\/sh\n[\s\S]*?\nset -eu\n/)
  })

  test('on-mode side effects (iptables OUTPUT rules, the agent-exec setpriv drop) appear only on the on-branch — the off-branch execs the agent directly without firewall installation', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    expect(offBranchEnd).toBeGreaterThan(-1)
    const offBranch = shim.slice(0, offBranchEnd)
    expect(offBranch).not.toContain('iptables -A OUTPUT')
    expect(offBranch).toMatch(/exec bun run typeclaw "\$@"/)
    expect(offBranch).not.toMatch(/exec setpriv [^\n]*-- bun run typeclaw/)
  })

  test('per-agent Dockerfile wires ENTRYPOINT to the shim path, not directly to bun run', () => {
    const out = buildDockerfile()
    expect(out).toContain(`ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]`)
    expect(out).not.toContain('ENTRYPOINT ["bun", "run", "typeclaw"]')
    expect(out).toContain('CMD ["run"]')
  })

  test('per-agent Dockerfile installs the shim via base64 decode of buildEntrypointShim() output', () => {
    const out = buildDockerfile()
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(out).toContain(`echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH}`)
    expect(out).toContain(`chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`)
  })

  test('base Dockerfile carries the same shim install so prebuilt-base images do not need a per-agent rebuild for it', () => {
    const base = buildBaseDockerfile()
    const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
    expect(base).toContain(encoded)
    expect(base).toContain(TYPECLAW_ENTRYPOINT_PATH)
  })

  test('resolver carve-out is gated on TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1 (default-on via container env, opt-out by setting to 0)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS:-0}" = "1"')
  })

  test('resolver carve-out reads /etc/resolv.conf and ACCEPTs udp+tcp dport 53 to each nameserver (fixes EC2 VPC DNS at 10.0.0.2)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('/etc/resolv.conf')
    expect(shim).toContain("awk '/^[[:space:]]*nameserver[[:space:]]+/{print $2}'")
    expect(shim).toContain('iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT')
    expect(shim).toContain('iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT')
  })

  test('resolver carve-out filters IPv6 nameservers via grep -v : so iptables never sees a v6 address', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/grep -v ':'/)
  })

  test('resolver carve-out is guarded by -r /etc/resolv.conf so a missing file fails open (not a crash under set -e)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('[ -r /etc/resolv.conf ]')
  })

  test('user-supplied allow list is driven by TYPECLAW_NETWORK_ALLOW (comma-separated)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_ALLOW:-}"')
    expect(shim).toContain("IFS=','")
    expect(shim).toContain('iptables -A OUTPUT -d "$cidr" -j ACCEPT')
  })

  test('ACCEPT carve-outs are written BEFORE the REJECT block list (first-match-wins on OUTPUT)', () => {
    const shim = buildEntrypointShim()
    const resolverIdx = shim.indexOf('--dport 53 -j ACCEPT')
    const allowIdx = shim.indexOf('iptables -A OUTPUT -d "$cidr" -j ACCEPT')
    const firstRejectIdx = shim.indexOf('-j REJECT --reject-with icmp-port-unreachable')

    expect(resolverIdx).toBeGreaterThan(-1)
    expect(allowIdx).toBeGreaterThan(-1)
    expect(firstRejectIdx).toBeGreaterThan(-1)
    expect(resolverIdx).toBeLessThan(firstRejectIdx)
    expect(allowIdx).toBeLessThan(firstRejectIdx)
  })

  test('resolver carve-out also runs in the on-branch only, never in the off path', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    const offBranch = shim.slice(0, offBranchEnd)
    expect(offBranch).not.toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS')
    expect(offBranch).not.toContain('TYPECLAW_NETWORK_ALLOW')
    expect(offBranch).not.toContain('/etc/resolv.conf')
  })

  test('allow loop unsets IFS after splitting so subsequent commands see a clean environment', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('unset IFS')
  })
})

describe('entrypoint shim — executable behavior (Xvfb startup, fail-fast)', () => {
  let workdir: string
  let bindir: string
  let logfile: string

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'typeclaw-shim-test-'))
    bindir = join(workdir, 'bin')
    await mkdir(bindir, { recursive: true })

    logfile = join(workdir, 'agent-args.log')

    // Fake `setpriv` that ignores all flags up to `--` and then execs the
    // rest. Real setpriv drops capabilities; the test doesn't care about
    // capabilities, only that the wrapped command runs.
    await writeShellScript(
      join(bindir, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break;;
    --*) shift;;
    *) shift;;
  esac
done
exec "$@"
`,
    )

    // Fake `bun` that records its argv and the value of $DISPLAY, then
    // exits 0. Stands in for the real \`bun run typeclaw "$@"\` exec at
    // the end of the shim.
    await writeShellScript(
      join(bindir, 'bun'),
      `#!/bin/sh
{
  echo "argv: $*"
  echo "DISPLAY: \${DISPLAY:-<unset>}"
} > "${logfile}"
exit 0
`,
    )
  })

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test('off-path: when Xvfb exits immediately, the shim writes a diagnostic to stderr and exits non-zero (no silent failure)', async () => {
    // Fake Xvfb that exits 1 the instant it starts. The shim's
    // `kill -0 $xvfb_pid` check should detect this on the next poll
    // iteration and `exit 1` with a clear stderr line.
    await writeShellScript(
      join(bindir, 'Xvfb'),
      `#!/bin/sh
exit 1
`,
    )

    const shim = buildEntrypointShim()
    const failShimPath = join(workdir, 'shim-fail.sh')
    await writeShellScript(failShimPath, shim)

    const proc = Bun.spawn(['/bin/sh', failShimPath, 'run'], {
      env: { PATH: `${bindir}:${process.env['PATH'] ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('typeclaw-entrypoint: Xvfb exited immediately')
  })

  test('off-path: when Xvfb is not on PATH (docker.file.xvfb=false equivalent), the shim execs the agent directly without spawning anything or exporting DISPLAY', async () => {
    // Make Xvfb unfindable by pointing PATH at a directory that lacks it.
    // Keep the rest of the fakes (bun, setpriv) reachable via the same
    // bindir but rename the Xvfb fake aside.
    const isolatedBin = join(workdir, 'bin-no-xvfb')
    await mkdir(isolatedBin, { recursive: true })
    // Symlink in the bun + setpriv fakes only; leave Xvfb out.
    await writeShellScript(
      join(isolatedBin, 'bun'),
      `#!/bin/sh\necho "DISPLAY: \${DISPLAY:-<unset>}" > "${logfile}"\nexit 0\n`,
    )
    await writeShellScript(
      join(isolatedBin, 'setpriv'),
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; *) shift;; esac; done
exec "$@"
`,
    )

    const shim = buildEntrypointShim()
    const noXvfbShimPath = join(workdir, 'shim-no-xvfb.sh')
    await writeShellScript(noXvfbShimPath, shim)

    const proc = Bun.spawn(['/bin/sh', noXvfbShimPath, 'run'], {
      env: { PATH: isolatedBin },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    const log = await Bun.file(logfile).text()
    expect(log).toContain('DISPLAY: <unset>')
  })
})

async function writeShellScript(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 })
}

// vercel-labs/agent-browser issue #1083 ("headed silently ignored on
// existing session") leaves --headed / AGENT_BROWSER_HEADED a no-op
// once a daemon has launched a browser headless. Three upstream fix PRs
// (#660, #370, #387) are open and unmerged. Layer 4.5 shims the
// agent-browser binary so a best-effort `agent-browser close` runs
// before `open`/`goto`/`navigate` when headed mode is requested. These
// tests pin the structural invariants (wrapper present in every
// Dockerfile that ships agent-browser, ordering after install, omitted
// when the base image already carries it) and the behavioral matrix
// (allowlist scope, upstream-matching truthy contract, re-entrancy
// defense, exit-code passthrough). Allowlist over denylist is
// deliberate per oracle self-review: pre-closing stateful commands
// (chat, connect, record, trace, tab, batch, stream, ...) would destroy
// live browser/page state the user expects to keep.
describe('agent-browser headed-mode wrapper (Layer 4.5)', () => {
  test('per-agent inline Dockerfile installs the wrapper after the agent-browser bun install — pre-close depends on the real binary existing at the path the wrapper mv-aliases', () => {
    const out = buildDockerfile()
    const installIdx = out.indexOf('bun install -g agent-browser')
    const wrapperIdx = out.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(installIdx).toBeGreaterThan(-1)
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(installIdx).toBeLessThan(wrapperIdx)
  })

  test('base Dockerfile carries the wrapper too — without it the prebuilt GHCR base ships an unpatched agent-browser, and the per-agent versioned Dockerfile (which omits the install layer) has no way to add the wrapper itself', () => {
    const base = buildBaseDockerfile()
    expect(base).toContain('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(base).toContain('TYPECLAW_AGENT_BROWSER_WRAPPER_EOF')
    const installIdx = base.indexOf('bun install -g agent-browser')
    const wrapperIdx = base.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(installIdx).toBeLessThan(wrapperIdx)
  })

  test('versioned per-agent Dockerfile omits the wrapper RUN block — the base image already carries it (paired with the install layer) so re-applying would mv a non-existent .real file and break the build', () => {
    const out = buildDockerfile(dockerfileSchema.parse({}), { baseImageVersion: '0.1.1' })
    expect(out).not.toContain('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    expect(out).not.toContain('TYPECLAW_AGENT_BROWSER_WRAPPER_EOF')
  })

  test('wrapper appears before the Chrome-for-Testing download — pre-close behavior cannot depend on whether the browser binary is present, and the layer ordering is the only thing that guarantees a clean mv+rewrite without racing the install step', () => {
    const out = buildDockerfile()
    const wrapperIdx = out.indexOf('mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser.real')
    const chromeIdx = out.indexOf('agent-browser install --with-deps')
    expect(wrapperIdx).toBeGreaterThan(-1)
    expect(chromeIdx).toBeGreaterThan(-1)
    expect(wrapperIdx).toBeLessThan(chromeIdx)
  })

  test('Chrome-for-Testing download in Layer 5 invokes the shimmed agent-browser binary — `agent-browser install` is not on the allowlist so the wrapper passes through unchanged at build time', () => {
    const out = buildDockerfile()
    expect(out).toContain('agent-browser install --with-deps')
    const wrapperBody = extractWrapperBody(out)
    expect(wrapperBody).toContain('open|goto|navigate')
  })
})

describe('agent-browser headed-mode wrapper — executable behavior', () => {
  let workdir: string
  let bindir: string
  let logfile: string
  let wrapperPath: string

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'typeclaw-ab-wrap-'))
    bindir = join(workdir, 'bin')
    await mkdir(bindir, { recursive: true })
    logfile = join(workdir, 'real-calls.log')

    const realPath = join(bindir, 'agent-browser.real')
    await writeShellScript(
      realPath,
      `#!/bin/sh
{
  echo "args=[$*]"
  echo "HEADED=\${AGENT_BROWSER_HEADED-unset}"
  echo "handled=\${_TYPECLAW_AGENT_BROWSER_HEADED_HANDLED-unset}"
  echo "---"
} >> "${logfile}"
exit 0
`,
    )

    wrapperPath = join(bindir, 'agent-browser')
    await writeFile(wrapperPath, extractWrapperBody(buildDockerfile()), { mode: 0o755 })
  })

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  async function runWrapper(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ exitCode: number; calls: string[] }> {
    await writeFile(logfile, '')
    const proc = Bun.spawn([wrapperPath, ...args], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: join(bindir, 'agent-browser.real'),
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const log = await Bun.file(logfile).text()
    const calls = log
      .split('---\n')
      .map((s) => s.trim())
      .filter(Boolean)
    return { exitCode, calls }
  }

  test('no headed signal: skips pre-close and calls the real binary once with the original args', async () => {
    const { exitCode, calls } = await runWrapper(['snapshot'])
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[snapshot]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('AGENT_BROWSER_HEADED=1 + open: allowlist hit, pre-closes first then exec-passes through', async () => {
    const { exitCode, calls } = await runWrapper(['open', 'https://example.com'], { AGENT_BROWSER_HEADED: '1' })
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('args=[close]')
    expect(calls[1]).toContain('args=[open https://example.com]')
  })

  test('AGENT_BROWSER_HEADED=1 + goto / navigate aliases: also on the allowlist (upstream maps both to the same action as open)', async () => {
    for (const sub of ['goto', 'navigate']) {
      const { calls } = await runWrapper([sub, 'https://example.com'], { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
      expect(calls[1]).toContain(`args=[${sub} https://example.com]`)
    }
  })

  test('allowlist matches subcommand semantics, not flag soup — headed env without an allowed subcommand never pre-closes', async () => {
    const nonAllowlisted = [
      ['click', '#btn'],
      ['snapshot'],
      ['screenshot'],
      ['eval', '1+1'],
      ['chat', 'hi'],
      ['connect', '9222'],
      ['batch'],
      ['tab', 'list'],
      ['record', 'start', '/tmp/r.webm'],
      ['trace', 'start'],
      ['stream', 'enable'],
      ['cookies', 'get'],
      ['network', 'route', 'https://x'],
      ['react', 'tree'],
      ['vitals'],
    ]
    for (const args of nonAllowlisted) {
      const { calls } = await runWrapper(args, { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(`args=[${args.join(' ')}]`)
      expect(calls[0]).toContain('handled=unset')
    }
  })

  test('--headed argv on a non-allowlisted subcommand: still no pre-close — the wrapper trusts the allowlist over the headed signal so stateful commands stay untouched', async () => {
    const { calls } = await runWrapper(['click', '#btn', '--headed'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[click #btn --headed]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('--headed argv forms on open: bare --headed, --headed=true, --headed=1 all trigger pre-close', async () => {
    for (const flag of ['--headed', '--headed=true', '--headed=1']) {
      const { calls } = await runWrapper([flag, 'open', 'https://x'])
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
      expect(calls[1]).toContain(`args=[${flag} open https://x]`)
    }
  })

  test('AGENT_BROWSER_HEADED broad truthy contract matches upstream env_var_is_truthy: any non-empty value except case-insensitive 0/false/no is truthy', async () => {
    const truthy = ['1', 'true', 'TRUE', 'True', 'yes', 'y', 'on', 'enable', 'random', '2']
    for (const value of truthy) {
      const { calls } = await runWrapper(['open', 'https://x'], { AGENT_BROWSER_HEADED: value })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('args=[close]')
    }
  })

  test('AGENT_BROWSER_HEADED falsy values bypass pre-close: 0, false, FALSE, False, no, NO, No, empty', async () => {
    const falsy = ['0', 'false', 'FALSE', 'False', 'no', 'NO', 'No', '']
    for (const value of falsy) {
      const { calls } = await runWrapper(['open', 'https://x'], { AGENT_BROWSER_HEADED: value })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('args=[open https://x]')
    }
  })

  test('close subcommand under headed env: NOT on the allowlist, passes through directly so the user-issued close runs once instead of cascading into a wrapper-injected pre-close', async () => {
    const { exitCode, calls } = await runWrapper(['close'], { AGENT_BROWSER_HEADED: '1' })
    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[close]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('--help and --version under headed env: no subcommand match, no pre-close — printing help must never kill an active browser', async () => {
    for (const flag of ['--help', '-h', '--version', '-V']) {
      const { calls } = await runWrapper([flag], { AGENT_BROWSER_HEADED: '1' })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(`args=[${flag}]`)
      expect(calls[0]).toContain('handled=unset')
    }
  })

  test('no-args invocation under headed env: empty argv, no allowlist match, no pre-close', async () => {
    const { calls } = await runWrapper([], { AGENT_BROWSER_HEADED: '1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[]')
    expect(calls[0]).toContain('handled=unset')
  })

  test('re-entrancy guard: _TYPECLAW_AGENT_BROWSER_HEADED_HANDLED=1 at entry triggers the top-of-script bypass — defends against future subcommands that shell out to agent-browser as a subprocess while headed env is still set', async () => {
    const { calls } = await runWrapper(['open', 'https://x'], {
      AGENT_BROWSER_HEADED: '1',
      _TYPECLAW_AGENT_BROWSER_HEADED_HANDLED: '1',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('args=[open https://x]')
    expect(calls[0]).toContain('handled=1')
  })

  test("exit code passes through from the real binary even when pre-close was attempted — the wrapper must never mask the real command's exit status", async () => {
    const failingReal = join(bindir, 'agent-browser-fail.real')
    await writeShellScript(failingReal, `#!/bin/sh\nexit 42\n`)
    const proc = Bun.spawn([wrapperPath, 'open', 'https://x'], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: failingReal,
        AGENT_BROWSER_HEADED: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(42)
  })

  test("pre-close failure is tolerated: when the real binary returns non-zero on close (e.g. stale socket, network blip), the wrapper still execs the user's actual command — false negatives on pre-close must never block legitimate calls", async () => {
    const flakyReal = join(bindir, 'agent-browser-flaky.real')
    await writeShellScript(
      flakyReal,
      `#!/bin/sh
case "$1" in
  close) exit 7 ;;
  *) echo "open_ran" > "${join(workdir, 'flaky-open.flag')}"; exit 0 ;;
esac
`,
    )
    const proc = Bun.spawn([wrapperPath, 'open', 'https://x'], {
      env: {
        PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
        TYPECLAW_AGENT_BROWSER_REAL: flakyReal,
        AGENT_BROWSER_HEADED: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    const flagPath = join(workdir, 'flaky-open.flag')
    expect(await Bun.file(flagPath).text()).toContain('open_ran')
  })
})

function extractWrapperBody(dockerfile: string): string {
  const shebangIdx = dockerfile.indexOf('#!/bin/sh')
  const endIdx = dockerfile.indexOf('\nTYPECLAW_AGENT_BROWSER_WRAPPER_EOF', shebangIdx)
  if (shebangIdx < 0 || endIdx < 0) throw new Error('wrapper heredoc not found in Dockerfile')
  return dockerfile.slice(shebangIdx, endIdx)
}
