export const DOCKERFILE = 'Dockerfile'

export function buildDockerfile(): string {
  return `FROM oven/bun:1-slim

WORKDIR /agent

# git is required for the agent runtime (cloning, committing workspace state,
# version-controlled tooling), so it ships in every agent image regardless of
# what the user installs on top.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates \\
 && rm -rf /var/lib/apt/lists/*

# agent-browser is bundled in every agent image so browser automation works
# out of the box. The CLI is installed globally (outside /agent) so it survives
# the runtime bind-mount that overlays node_modules at /agent/node_modules.
# \`agent-browser install --with-deps\` downloads Chrome for Testing into
# ~/.cache/agent-browser and installs the apt packages Chrome needs (libnss,
# libxss, fonts, etc.). Both land in the image's writable layer at build time
# so cold starts are zero-setup.
RUN bun install -g agent-browser \\
 && agent-browser install --with-deps

# The agent folder (including node_modules) is bind-mounted at runtime by
# \`typeclaw start\`, so we do not COPY or install here. This keeps the image
# tiny and lets edits on the host take effect without rebuilds.

ENV NODE_ENV=production

ENTRYPOINT ["bun", "run", "typeclaw"]
CMD ["run"]
`
}
