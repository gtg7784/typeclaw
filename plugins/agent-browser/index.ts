import { join } from 'node:path'

import { definePlugin } from '@/plugin'

import { installShim, KNOWN_BIN_PATHS, type InstallShimResult } from './shim-install'

type SafeResult = InstallShimResult | { kind: 'error'; binPath: string; error: unknown }

export default definePlugin({
  plugin: async (ctx) => {
    for (const binPath of Object.values(KNOWN_BIN_PATHS)) {
      logInstallResult(ctx.logger, safeInstallShim(binPath))
    }

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})

function safeInstallShim(binPath: string): SafeResult {
  try {
    return installShim({ binPath })
  } catch (error) {
    return { kind: 'error', binPath, error }
  }
}

function logInstallResult(
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  result: SafeResult,
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
    logger.info(`no agent-browser binary at ${result.binPath}; skipping`)
    return
  }
  logger.warn(`failed to install agent-browser shim at ${result.binPath}: ${String(result.error)}`)
}
