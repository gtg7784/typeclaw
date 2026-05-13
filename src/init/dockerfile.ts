import type { DockerfileConfig, DockerfileFeatureToggle } from '@/config/config'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'

export const DOCKERFILE = 'Dockerfile'

export type BuildDockerfileOptions = {
  // Null or omitted = emit the full inline heavy stack (dev mode, tests).
  baseImageVersion?: string | null
}

// Apt packages that EVERY image must have — git for the agent runtime,
// curl/ca-certificates/gnupg for HTTPS and key fetches that downstream layers
// (e.g. the gh keyring) depend on. `iptables` and `util-linux` back the
// network egress entrypoint shim, installed unconditionally so that flipping
// `typeclaw.json#network.blockInternal` is a runtime toggle (re-run
// `typeclaw restart`) and not an image rebuild.
//
// On Debian trixie the single `iptables` package ships both the IPv4 nft
// frontend (`iptables-nft`, available as `iptables` through
// update-alternatives) and the IPv6 nft frontend (`ip6tables-nft`, available
// as `ip6tables`). The standalone `iptables-nft`/`ip6tables-nft` package
// names do NOT exist on trixie — `apt install iptables-nft` fails with
// "Unable to locate package". The shim invokes `iptables` and `ip6tables`
// which alternatives resolves to the nft variants.
//
// `util-linux` carries `setpriv`, which the shim uses to drop CAP_NET_ADMIN
// from the bounding set before exec'ing the agent. Listed first in the
// apt-get install line so the package set is self-documenting at a glance.
const BASELINE_APT_PACKAGES = ['git', 'ca-certificates', 'curl', 'gnupg', 'iptables', 'util-linux'] as const

// curl-impersonate is the only currently-working way to query DuckDuckGo from
// a non-browser client on residential IPs in 2026. DDG fingerprints incoming
// requests at the TLS handshake (JA3/JA4) and HTTP/2 SETTINGS-frame layer
// before any HTTP headers are read; Bun's native fetch cannot match Chrome's
// fingerprint (upstream Bun issue #11368, open) so requests get gated behind
// 202 anomaly-modal responses, escalating to interactive duck-picker
// challenges. See `src/agent/tools/ddg.ts` for the runtime invocation.
//
// Pinned to lexiforest's actively-maintained fork (Chrome 136+ profiles in
// v1.5.6, May 2026), NOT the original `lwthiker/curl-impersonate` whose last
// release v0.6.1 (March 2024) carries Chrome ≤116 profiles — two years stale
// and useless against current DDG fingerprinting. Bumping: replace the
// version + sha256 constants below and run `typeclaw start --build` in any
// agent folder per the AGENTS.md "owns the Dockerfile" rule. Verify the new
// release ships the wrapper named in CURL_IMPERSONATE_PROFILE; lexiforest
// regenerates the bundled wrappers on Chrome major bumps and occasionally
// drops older ones.
export const CURL_IMPERSONATE_VERSION = 'v1.5.6'
export const CURL_IMPERSONATE_SHA256_AMD64 = 'b60344f63b9ed8806f0e9f7fd357d9f6c9a82aca279ed1e9e257d544885dcbde'
export const CURL_IMPERSONATE_SHA256_ARM64 = '6766bc67fd3e8e2313875f32b36b5a3fab02beffe77e5f1cf7fc5da99731d403'
// Wrapper symlink shipped in the v1.5.6 tarball. The tarball lays out
// curl_chrome136 → curl_chrome alongside the canonical `curl-impersonate`
// binary; we invoke the version-pinned wrapper so a future release that
// drops chrome136 fails loudly at search time instead of silently regressing
// the impersonation to whatever `curl_chrome` resolves to.
export const CURL_IMPERSONATE_PROFILE = 'chrome136'

export const TYPECLAW_ENTRYPOINT_PATH = '/usr/local/bin/typeclaw-entrypoint'

// IPv4 networks the container is forbidden to egress to when
// `network.blockInternal` is true. Loopback (127/8) is NOT here — loopback
// traffic uses the `lo` interface, which the shim's first ACCEPT rule
// short-circuits. The agent inside the container needs loopback to dogfood
// its own `bun run dev` server. RFC1918 (10/8, 172.16/12, 192.168/16) covers
// router admin panels and home/office LANs. 169.254/16 covers cloud
// metadata (169.254.169.254 IMDS, 169.254.170.2 ECS task role) and Windows
// APIPA. 100.64/10 is CGNAT. 224/4 multicast and 240/4 reserved are belt-
// and-suspenders against creative exfil targets. host.docker.internal (in
// 172.16/12 on Docker Desktop/Linux) is re-allowed by the shim at runtime
// via getent so the agent's `restart` tool can still reach hostd.
export const NETWORK_BLOCK_IPV4_NETS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

// IPv6 mirrors of the IPv4 block list. fc00::/7 is unique-local (the IPv6
// equivalent of RFC1918), fe80::/10 is link-local (incl. SLAAC + IPv6 cloud
// metadata in fd00:ec2::/64 which fits inside fc00::/7), ff00::/8 is
// multicast, ::ffff:0:0/96 is IPv4-mapped IPv6 (an attacker could otherwise
// reach 192.168.x.x via [::ffff:192.168.0.1]).
export const NETWORK_BLOCK_IPV6_NETS = ['fc00::/7', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96'] as const

// Renders the shell script that runs as PID 1 inside the container. Two
// modes, picked at boot time from `$TYPECLAW_NETWORK_BLOCK_INTERNAL`:
//
//   off (default, blockInternal=false or env unset): no rules installed,
//   no setpriv. Just exec `bun run typeclaw "$@"`. Identical observable
//   behavior to the pre-feature container.
//
//   on (blockInternal=true): walks IPv4 + IPv6 block lists and installs
//   REJECT rules in the OUTPUT chain. Loopback (`-o lo`) is ACCEPT'd first
//   so dev-server dogfooding still works. The hostd HTTP control port on
//   `host.docker.internal` is re-allowed at runtime — narrowly, single
//   TCP destport, only when hostd is configured — so the agent's `restart`
//   tool can still reach the daemon. The shim then drops CAP_NET_ADMIN
//   from the bounding set AND from the inheritable + ambient sets via
//   setpriv before exec'ing the agent. Bounding set is the hard ceiling
//   enforced by execve; inheritable + ambient are cleared defensively to
//   match setpriv(1)'s explicit warning about not dropping the bounding
//   set alone.
//
// Carve-out is intentionally narrow: ACCEPT only `tcp --dport <hostd-port>`
// to the host gateway, never the gateway IP wholesale. Without the dport
// scope, a compromised agent could reach any host service via
// `host.docker.internal:22` (SSH), `:53` (DNS), `:5432` (postgres), etc.
// The gateway IP itself sits inside `172.16.0.0/12`, which the IPv4 reject
// rules below DROP — the narrow ACCEPT here is the only path through.
// When hostd is not configured (`TYPECLAW_HOSTD_URL` unset or unparseable),
// nothing is ACCEPT'd: the agent loses self-restart capability but the
// rest of the egress filter still works.
//
// IPv4-only carve-out uses `getent ahostsv4` to force the resolver into
// the A-record path. Without this, `getent hosts` would return whichever
// family the resolver prefers, and on systems that prefer AAAA we'd feed
// a v6 address to `iptables` and crash under `set -e`. host.docker.internal
// resolves to a bridge gateway that is IPv4-only on every Docker runtime
// we support (Docker Desktop, OrbStack, Docker on Linux with the
// `--add-host host.docker.internal:host-gateway` flag typeclaw injects).
//
// REJECT (not DROP) so the agent fails fast with an ICMP unreachable
// instead of hanging on a 30-second connect timeout — much friendlier
// debug UX and identical security posture.
//
// `set -eu` propagates rule-install failures up to PID 1 exit, which kills
// the container. Failing closed is the right thing: an unenforced
// blockInternal=true is worse than blockInternal=false.
export function buildEntrypointShim(): string {
  const ipv4Rules = NETWORK_BLOCK_IPV4_NETS.map(
    (net) => `iptables -A OUTPUT -d ${net} -j REJECT --reject-with icmp-port-unreachable`,
  )
  const ipv6Rules = NETWORK_BLOCK_IPV6_NETS.map(
    (net) => `ip6tables -A OUTPUT -d ${net} -j REJECT --reject-with icmp6-port-unreachable`,
  )
  return `#!/bin/sh
# AUTOGENERATED by typeclaw — do not edit.
# Source: src/init/dockerfile.ts \`buildEntrypointShim()\`.
set -eu

if [ "\${TYPECLAW_NETWORK_BLOCK_INTERNAL:-0}" != "1" ]; then
  exec bun run typeclaw "$@"
fi

iptables -A OUTPUT -o lo -j ACCEPT

# Hostd HTTP control carve-out: narrow ACCEPT, scoped to one TCP port on
# the host gateway. Skipped silently when hostd is not configured.
hostd_port=""
if [ -n "\${TYPECLAW_HOSTD_URL:-}" ]; then
  hostd_port="$(printf '%s' "$TYPECLAW_HOSTD_URL" | sed -n 's#^https\\{0,1\\}://[^/:]\\{1,\\}:\\([0-9]\\{1,5\\}\\).*#\\1#p')"
fi
if [ -n "\${hostd_port:-}" ]; then
  host_gw_ip="$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1; exit}')"
  if [ -n "\${host_gw_ip:-}" ]; then
    iptables -A OUTPUT -p tcp -d "$host_gw_ip" --dport "$hostd_port" -j ACCEPT
  fi
fi
${ipv4Rules.join('\n')}

ip6tables -A OUTPUT -o lo -j ACCEPT
${ipv6Rules.join('\n')}

exec setpriv --bounding-set -net_admin --inh-caps -net_admin --ambient-caps -net_admin -- bun run typeclaw "$@"
`
}

// Layer 6: install the network-egress entrypoint shim. Content is base64-
// encoded inline so the Dockerfile is fully self-contained — no second file
// in the build context, no COPY, no chicken-and-egg between init and start.
// Layer placement is intentionally late: shim source changes invalidate
// only this small layer (~1KB image impact), keeping Chrome and apt cached.
function renderEntrypointShimLayer(): string {
  const encoded = Buffer.from(buildEntrypointShim(), 'utf8').toString('base64')
  return `# Layer 6 (small, changes with the egress shim): install /usr/local/bin/typeclaw-entrypoint.
# The shim is a no-op unless \`network.blockInternal\` is true at runtime.
RUN echo "${encoded}" | base64 -d > ${TYPECLAW_ENTRYPOINT_PATH} \\
 && chmod +x ${TYPECLAW_ENTRYPOINT_PATH}`
}

// Shared-library runtime deps Chrome for Testing needs to launch on amd64
// Debian trixie (base of `oven/bun:1-slim`). `agent-browser install
// --with-deps` (v0.27.0) is supposed to install these but silently no-ops:
// its hardcoded list omits `libglib2.0-0t64`, so Chrome dies on launch
// with `libglib-2.0.so.0: cannot open shared object file` even though the
// binary download and `--with-deps` both exit 0. We install the full
// Playwright-tested chromium dep set here in Layer 2 so the bug doesn't
// recur if upstream omits another package; Layer 5 still calls
// `--with-deps` as a no-op-on-cache-hit backstop for future deps.
//
// Package list mirrors Playwright's `debian13-x64` chromium deps in
// nativeDeps.ts (https://github.com/microsoft/playwright). t64-suffixed
// names are the trixie-renamed variants from the 64-bit time_t ABI
// transition; SONAMEs (libglib-2.0.so.0 etc.) are unchanged. Packages
// without t64 here have no t64 sibling on trixie — verified against
// packages.debian.org/trixie. Fonts are intentionally omitted: the
// reported failure is launch-time linker errors, not rendering glyphs;
// font packages (esp. fonts-noto-cjk) cost ~50MB+ for no launch impact.
export const CHROME_RUNTIME_APT_PACKAGES_AMD64 = [
  'libasound2t64',
  'libatk-bridge2.0-0t64',
  'libatk1.0-0t64',
  'libatspi2.0-0t64',
  'libcairo2',
  'libcups2t64',
  'libdbus-1-3',
  'libdrm2',
  'libgbm1',
  'libglib2.0-0t64',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
] as const

type AptFeature = {
  toAptArgs: (toggle: DockerfileFeatureToggle) => string[]
}

const APT_FEATURES: Record<'ffmpeg' | 'gh' | 'tmux' | 'python', AptFeature> = {
  ffmpeg: { toAptArgs: (v) => singlePackageArgs('ffmpeg', v) },
  gh: { toAptArgs: (v) => singlePackageArgs('gh', v) },
  tmux: { toAptArgs: (v) => singlePackageArgs('tmux', v) },
  python: {
    toAptArgs: (v) => (v === true ? ['python3', 'python3-pip', 'python3-venv', 'python-is-python3'] : []),
  },
}

export function buildDockerfile(
  config: DockerfileConfig = defaultConfig(),
  options: BuildDockerfileOptions = {},
): string {
  const toggleAptArgs = collectToggleAptArgs(config)
  const ghKeyringLayer = renderGhKeyringLayer(config.gh)
  const customLines = renderCustomDockerfileLines(config.append)
  const baseImageVersion = options.baseImageVersion ?? null

  const fromAndHeavyLayers =
    baseImageVersion !== null
      ? renderVersionedHead(baseImageVersion, ghKeyringLayer, toggleAptArgs)
      : renderInlineHead(ghKeyringLayer, toggleAptArgs)

  return `${BUILDKIT_HEADER}
# AUTOGENERATED by typeclaw — do not edit.
# This file is rewritten on every \`typeclaw start\` from src/init/dockerfile.ts
# in the typeclaw repo. Local edits will be overwritten (and committed away if
# the working tree is dirty). To change the template, edit dockerfile.ts there.

${fromAndHeavyLayers}
# The agent folder (including node_modules) is bind-mounted at runtime by
# \`typeclaw start\`, so we do not COPY or install here. This keeps the image
# tiny and lets edits on the host take effect without rebuilds.

ENV NODE_ENV=production

# Pin agent-messenger's config dir into the agent's workspace/ so KakaoTalk
# (and any future agent-messenger-backed channel) reads/writes credentials
# inside the bind-mounted agent folder. Without this, the SDK would default
# to /root/.config/agent-messenger inside the container, which doesn't
# survive container restarts and isn't visible from the host. The agent
# folder's bind-mount maps /agent → host's agent dir, so the credentials
# end up at <agentDir>/workspace/.agent-messenger/ on the host.
ENV AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger

${customLines}ENTRYPOINT ["${TYPECLAW_ENTRYPOINT_PATH}"]
CMD ["run"]
`
}

// FROMs the prebuilt typeclaw-base image at the pinned version. Heavy
// layers (apt baseline, Chrome runtime libs, curl-impersonate, agent-browser,
// Chrome for Testing) are already in that image, so the per-agent head only
// re-runs the toggle apt install and (optionally) the gh keyring bootstrap.
//
// The entrypoint shim is ALSO re-emitted here, even though the base image
// already carries it. Two reasons: (1) older base images published before
// the shim landed (or before a shim source edit) don't have the up-to-date
// binary at TYPECLAW_ENTRYPOINT_PATH, and the per-agent ENTRYPOINT line
// would crash on startup with `stat: no such file or directory`. Re-emitting
// is ~1KB of image and keeps the contract local: whatever per-agent
// Dockerfile we emit guarantees the shim path exists, regardless of which
// base-image vintage we FROM. (2) Edits to `buildEntrypointShim()` ship via
// npm + `typeclaw start --build` immediately, instead of being blocked on a
// fresh base-image release. The base image's copy is harmlessly overwritten
// by this RUN — same path, same chmod.
function renderVersionedHead(baseImageVersion: string, ghKeyringLayer: string, toggleAptArgs: string[]): string {
  const toggleAptLayer = toggleAptArgs.length === 0 ? '' : `${renderToggleAptInstallLayer(toggleAptArgs)}\n\n`
  return `FROM ${GHCR_BASE_IMAGE_REPO}:${baseImageVersion}

WORKDIR /agent

ARG TARGETARCH

${ghKeyringLayer}${toggleAptLayer}${renderEntrypointShimLayer()}

`
}

// FROMs oven/bun:1-slim and rebuilds the full heavy stack inline. Used by
// dev-mode runs (typeclaw installed via file: / link: spec) where the
// matching :version GHCR tag does not yet exist, and by the test suite to
// keep coverage of the full-stack layers independent of GHCR availability.
function renderInlineHead(ghKeyringLayer: string, toggleAptArgs: string[]): string {
  const baselineAndToggleArgs = [...BASELINE_APT_PACKAGES, ...toggleAptArgs]
  return `${FROM_AND_WORKDIR}

# Layers are ordered most-stable first to maximize Docker layer cache hits on
# rebuilds. Anything that pulls from npm (volatile) sits below anything that
# pulls from apt (stable, version-pinned by the base image's debian release),
# and the heavy Chrome-for-Testing download on amd64 is isolated in its own
# final layer so unrelated changes do not invalidate it.

${LAYER_0_APT_KEEP_CACHE}

${ghKeyringLayer}# Layer 2 (changes when the package list changes): the actual apt install.
# Cache mounts make a re-install nearly free when this layer is invalidated:
# .deb files come straight from the host's BuildKit cache instead of being
# refetched from Debian/GitHub mirrors. Package set is composed from the
# \`dockerfile\` config block in typeclaw.json — toggles for tmux/python/gh/
# ffmpeg fan out into the args below. Baseline (git/ca-certificates/curl/
# gnupg) is always installed because downstream layers depend on it.
#
# No \`rm -rf /var/lib/apt/lists/*\` because the lists live on a cache mount
# that is excluded from the image layer by definition.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${baselineAndToggleArgs.join(' ')} \\
 && if [ "$TARGETARCH" = "arm64" ]; then \\
      apt-get install -y --no-install-recommends chromium; \\
    else \\
      apt-get install -y --no-install-recommends \\
        ${CHROME_RUNTIME_APT_PACKAGES_AMD64.join(' ')}; \\
    fi

${LAYER_2_5_CURL_IMPERSONATE}

${LAYER_3_AGENT_BROWSER_ARM64_CONFIG}

${LAYER_4_AGENT_BROWSER_INSTALL}

${LAYER_5_CHROME_FOR_TESTING}

${renderEntrypointShimLayer()}

`
}

function renderToggleAptInstallLayer(toggleAptArgs: string[]): string {
  return `# Layer 1 (toggle apt install): packages requested via typeclaw.json
# #dockerfile toggles. Baseline + Chrome runtime libs are already in the
# base image; this layer only adds gh/tmux/python/ffmpeg if enabled.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${toggleAptArgs.join(' ')}`
}

// Recipe for the prebuilt typeclaw-base image published to
// ghcr.io/typeclaw/typeclaw-base by .github/workflows/base-image.yml. Built
// from the same constants and layer templates as buildDockerfile() so the
// two cannot drift — the published image is a function of this source, not
// a checked-in Dockerfile that needs hand-syncing. The base intentionally
// stops before the per-agent layers (gh keyring, apt feature toggles,
// dockerfile.append, ENV, ENTRYPOINT) so users can still toggle them via
// typeclaw.json without forcing a base-image rebuild.
//
// Layer 2's apt-get install line installs only the baseline packages, NOT
// the gh/python/tmux/ffmpeg toggles — those layer onto the base in the
// per-agent Dockerfile.
export function buildBaseDockerfile(): string {
  return `${BUILDKIT_HEADER}
# AUTOGENERATED by scripts/emit-base-dockerfile.ts from src/init/dockerfile.ts.
# Do not edit by hand — your changes will be lost on the next CI run.

${FROM_AND_WORKDIR}

${LAYER_0_APT_KEEP_CACHE}

# Layer 2 (baseline only): apt baseline + Chrome runtime libs. Toggle-driven
# packages (gh/python/tmux/ffmpeg) are intentionally NOT installed here —
# they layer onto the base in the per-agent Dockerfile so users can opt in/
# out via typeclaw.json without forcing a base-image rebuild.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update \\
 && apt-get install -y --no-install-recommends \\
      ${BASELINE_APT_PACKAGES.join(' ')} \\
 && if [ "$TARGETARCH" = "arm64" ]; then \\
      apt-get install -y --no-install-recommends chromium; \\
    else \\
      apt-get install -y --no-install-recommends \\
        ${CHROME_RUNTIME_APT_PACKAGES_AMD64.join(' ')}; \\
    fi

${LAYER_2_5_CURL_IMPERSONATE}

${LAYER_3_AGENT_BROWSER_ARM64_CONFIG}

${LAYER_4_AGENT_BROWSER_INSTALL}

${LAYER_5_CHROME_FOR_TESTING}

${renderEntrypointShimLayer()}
`
}

// Shared layer templates. Both buildDockerfile() (per-agent) and
// buildBaseDockerfile() (prebuilt base image) compose from these so the
// two outputs cannot drift on Chrome runtime libs, curl-impersonate
// version, or the agent-browser install path.

const BUILDKIT_HEADER = `# syntax=docker/dockerfile:1.7`

const FROM_AND_WORKDIR = `FROM oven/bun:1-slim

WORKDIR /agent

ARG TARGETARCH`

// Layer 0: defeat Debian's apt auto-clean so \`--mount=type=cache\` below
// actually retains downloaded .debs across builds. The default
// /etc/apt/apt.conf.d/docker-clean (inherited from debian:slim) deletes
// /var/cache/apt/archives at the end of every apt invocation, which would
// nullify our cache mount. Also pre-create the keyring dir so the gh repo
// layer in the per-agent Dockerfile is one cheap cp/echo with no mkdir.
const LAYER_0_APT_KEEP_CACHE = `# Layer 0 (rarely changes): defeat Debian's apt auto-clean so cache mounts
# below actually retain downloaded .debs across builds.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \\
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \\
 && mkdir -p -m 755 /etc/apt/keyrings`

// Layer 2.5: install pinned curl-impersonate (lexiforest fork) for the
// websearch tool's DDG scraper. Required to evade DDG's TLS/HTTP2
// fingerprinting on residential IPs — see src/agent/tools/ddg.ts for the
// full rationale. Placed after Layer 2 so curl + ca-certificates + tar
// (already in baseline) are present, and before agent-browser so a version
// bump there doesn't invalidate this layer.
const LAYER_2_5_CURL_IMPERSONATE = `# Layer 2.5 (stable): pinned curl-impersonate (lexiforest fork) for DDG.
RUN ARCH_TARBALL="$(if [ "$TARGETARCH" = "arm64" ]; then echo aarch64-linux-gnu; else echo x86_64-linux-gnu; fi)" \\
 && ARCH_SHA="$(if [ "$TARGETARCH" = "arm64" ]; then echo ${CURL_IMPERSONATE_SHA256_ARM64}; else echo ${CURL_IMPERSONATE_SHA256_AMD64}; fi)" \\
 && cd /tmp \\
 && curl -fsSL -o curl-impersonate.tar.gz \\
      "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.\${ARCH_TARBALL}.tar.gz" \\
 && echo "\${ARCH_SHA}  curl-impersonate.tar.gz" | sha256sum -c - \\
 && tar -xzf curl-impersonate.tar.gz -C /usr/local/bin/ \\
 && rm curl-impersonate.tar.gz \\
 && /usr/local/bin/curl_${CURL_IMPERSONATE_PROFILE} --version > /dev/null`

const LAYER_3_AGENT_BROWSER_ARM64_CONFIG = `# Layer 3 (stable, arm64 only): point agent-browser at the apt-installed
# chromium. Independent of the npm install below so it stays cached across
# agent-browser version bumps.
RUN if [ "$TARGETARCH" = "arm64" ]; then \\
      mkdir -p /root/.agent-browser \\
   && printf '%s\\n' '{"executablePath":"/usr/bin/chromium"}' > /root/.agent-browser/config.json; \\
    fi`

const LAYER_4_AGENT_BROWSER_INSTALL = `# Layer 4 (volatile): install agent-browser globally so it survives the
# runtime bind-mount over /agent/node_modules.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \\
    bun install -g agent-browser`

// Layer 5: download the pinned Chrome for Testing build into
// ~/.agent-browser/browsers/. NO cache mount on that path because the
// runtime needs the binary in the image. System shared libraries are
// already installed in Layer 2; --with-deps is a defense-in-depth backstop
// so a future agent-browser bump that adds new deps installs them
// automatically (near-no-op when Layer 2 already covers them).
const LAYER_5_CHROME_FOR_TESTING = `# Layer 5 (heavy, amd64 only): Chrome for Testing download.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    if [ "$TARGETARCH" != "arm64" ]; then \\
      agent-browser install --with-deps; \\
    fi`

function defaultConfig(): DockerfileConfig {
  return { ffmpeg: false, gh: true, python: true, tmux: true, append: [] }
}

function collectToggleAptArgs(config: DockerfileConfig): string[] {
  const args: string[] = []
  for (const key of ['ffmpeg', 'gh', 'python', 'tmux'] as const) {
    args.push(...APT_FEATURES[key].toAptArgs(config[key]))
  }
  return args
}

function singlePackageArgs(name: string, toggle: DockerfileFeatureToggle): string[] {
  if (toggle === false) return []
  if (toggle === true) return [name]
  return [`${name}=${toggle}`]
}

// The gh keyring bootstrap is a separate layer so editing the package list
// (the most frequent change) does not re-fetch the GPG key over the network.
// When `gh` is disabled, omit the layer entirely — both to skip the network
// roundtrip on cold builds and to keep the package source registry clean.
function renderGhKeyringLayer(toggle: DockerfileFeatureToggle): string {
  if (toggle === false) return ''
  return `# Layer 1 (rarely changes): register the GitHub CLI apt repository and trust
# its keyring. Split from the package install below so editing the package
# list (the most frequent change to this Dockerfile) does NOT re-fetch the
# GPG key over the network. The cache mount on /var/cache/apt covers the
# tiny gnupg/curl install we need to bootstrap the key fetch.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update \\
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \\
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
      > /etc/apt/sources.list.d/github-cli.list

`
}

function renderCustomDockerfileLines(lines: string[]): string {
  if (lines.length === 0) return ''
  return `# Custom lines from typeclaw.json#dockerfile.append.
${lines.join('\n')}

`
}
