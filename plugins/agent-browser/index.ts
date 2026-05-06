import { join } from 'node:path'

import { definePlugin } from '@/plugin'

import { installShim, type InstallShimResult } from './shim-install'

export default definePlugin({
  plugin: async (ctx) => {
    const result = safeInstallShim()
    logInstallResult(ctx.logger, result)

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})

function safeInstallShim(): InstallShimResult | { kind: 'error'; error: unknown } {
  try {
    return installShim()
  } catch (error) {
    return { kind: 'error', error }
  }
}

function logInstallResult(
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  result: InstallShimResult | { kind: 'error'; error: unknown },
): void {
  if (result.kind === 'installed') {
    logger.info(`installed agent-browser shim at ${result.binPath} (real bin: ${result.realBin})`)
    return
  }
  if (result.kind === 'already-installed') {
    logger.info(`agent-browser shim already installed at ${result.binPath}`)
    return
  }
  if (result.kind === 'no-upstream') {
    logger.warn(
      `no upstream agent-browser binary found at ${result.binPath}; ` +
        `dashboard requests will run unproxied. Run \`bun install -g agent-browser\` inside the container.`,
    )
    return
  }
  logger.warn(`failed to install agent-browser shim: ${String((result as { error: unknown }).error)}`)
}
