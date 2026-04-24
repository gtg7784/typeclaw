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

# The agent folder (including node_modules) is bind-mounted at runtime by
# \`typeclaw up\`, so we do not COPY or install here. This keeps the image
# tiny and lets edits on the host take effect without rebuilds.

ENV NODE_ENV=production

ENTRYPOINT ["bun", "run", "typeclaw"]
CMD ["run"]
`
}
