import { describe, expect, test } from 'bun:test'

import { dockerfileSchema } from '@/config/config'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'
import {
  buildBaseDockerfile,
  buildDockerfile,
  buildEntrypointShim,
  CHROME_RUNTIME_APT_PACKAGES_AMD64,
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

  test('all toggles off: only baseline packages remain (incl. the egress-shim deps that ship unconditionally)', () => {
    const pkgs = aptPackages(
      buildDockerfile(dockerfileSchema.parse({ tmux: false, gh: false, python: false, ffmpeg: false })),
    )
    expect(pkgs).toEqual(['git', 'ca-certificates', 'curl', 'gnupg', 'iptables', 'util-linux'])
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

  test('base Dockerfile main apt-get install line installs only the baseline packages (no gh/python/tmux/ffmpeg)', () => {
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
    expect(countRunBlocksMatching(out, /curl-impersonate|sha256sum/)).toBe(0)
    expect(countRunBlocksMatching(out, /bun install -g agent-browser/)).toBe(0)
    expect(countRunBlocksMatching(out, /agent-browser install --with-deps/)).toBe(0)
    expect(countRunBlocksMatching(out, /apt-keep-cache|Keep-Downloaded-Packages/)).toBe(0)
    // and: no apt-get install line that also installs baseline packages
    expect(out).not.toMatch(/apt-get install[^\n]*\bgit\b[^\n]*\bca-certificates\b/)
  })

  test('with all toggles off: emits no apt install RUN block at all (zero-cost per-agent rebuild)', () => {
    // given: every toggle disabled, so no per-agent apt work is needed
    const out = buildDockerfile(dockerfileSchema.parse({ tmux: false, gh: false, python: false, ffmpeg: false }), {
      baseImageVersion: '0.1.1',
    })

    // then: zero apt-get blocks
    expect(countRunBlocksMatching(out, /apt-get/)).toBe(0)
  })

  test('with toggles on: emits exactly one apt install RUN block containing only toggle packages', () => {
    // given: gh + tmux enabled, python + ffmpeg disabled
    const out = buildDockerfile(dockerfileSchema.parse({ gh: true, tmux: true, python: false, ffmpeg: false }), {
      baseImageVersion: '0.1.1',
    })

    // then: there's an apt install line with exactly the toggle packages
    const aptInstallMatch = out.match(/apt-get install -y --no-install-recommends \\\n\s+([^\n]+)/)
    expect(aptInstallMatch).not.toBeNull()
    const pkgs = aptInstallMatch![1]!.split(/\s+/).filter(Boolean)
    expect(pkgs).toEqual(['gh', 'tmux'])
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
  test('is a no-op when TYPECLAW_NETWORK_BLOCK_INTERNAL is unset or not "1" (off-switch path: users who opted out via network.blockInternal=false)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toContain('"${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1"')
    expect(shim).toMatch(/!= "1" \];? then\s+exec bun run typeclaw "\$@"/)
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

  test('runs `set -eu` so an iptables failure brings PID 1 down (fail closed)', () => {
    const shim = buildEntrypointShim()
    expect(shim).toMatch(/^#!\/bin\/sh\n[\s\S]*?\nset -eu\n/)
  })

  test('on-mode rules appear in the on-branch only, never in the off path', () => {
    const shim = buildEntrypointShim()
    const offBranchEnd = shim.indexOf('fi\n', shim.indexOf('!= "1"'))
    expect(offBranchEnd).toBeGreaterThan(-1)
    const offBranch = shim.slice(0, offBranchEnd)
    expect(offBranch).not.toContain('iptables -A OUTPUT')
    expect(offBranch).not.toContain('setpriv')
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
