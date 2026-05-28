import { join } from 'node:path'

export type UpdateManager = 'bun' | 'npm' | 'pnpm' | 'yarn'
export type UpdateManagerSelection = 'auto' | UpdateManager

export type SelfUpdatePlan =
  | { ok: true; manager: UpdateManager; command: string[]; detectedFrom: string }
  | { ok: false; reason: string }

export function resolveSelfPackageJsonPath(): string {
  return join(import.meta.dir, '..', '..', 'package.json')
}

export function planSelfUpdate(options: { manager: UpdateManagerSelection; packageJsonPath?: string }): SelfUpdatePlan {
  const packageJsonPath = options.packageJsonPath ?? resolveSelfPackageJsonPath()
  const manager = options.manager === 'auto' ? detectInstallManager(packageJsonPath) : options.manager
  if (manager === null) {
    return {
      ok: false,
      reason:
        'Cannot auto-detect how TypeClaw was installed from this checkout. Re-run with --manager=bun, --manager=npm, --manager=pnpm, or --manager=yarn if you want to update a global install.',
    }
  }
  return {
    ok: true,
    manager,
    command: commandForManager(manager),
    detectedFrom: packageJsonPath,
  }
}

export function commandForManager(manager: UpdateManager): string[] {
  switch (manager) {
    case 'bun':
      return ['bun', 'update', '-g', 'typeclaw', '--latest']
    case 'npm':
      return ['npm', 'install', '-g', 'typeclaw@latest']
    case 'pnpm':
      return ['pnpm', 'add', '-g', 'typeclaw@latest']
    case 'yarn':
      return ['yarn', 'global', 'upgrade', 'typeclaw', '--latest']
  }
}

export function formatCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(' ')
}

function detectInstallManager(packageJsonPath: string): UpdateManager | null {
  const parts = packageJsonPath.split(/[\\/]+/).filter(Boolean)
  const packageJson = parts[parts.length - 1]
  const packageName = parts[parts.length - 2]
  const nodeModulesIdx = parts.lastIndexOf('node_modules')
  if (packageJson !== 'package.json' || packageName !== 'typeclaw' || nodeModulesIdx === -1) return null

  // Bun global: .bun/install/global/node_modules/typeclaw
  const bunGlobalIdx = parts.lastIndexOf('.bun')
  if (
    bunGlobalIdx !== -1 &&
    parts[bunGlobalIdx + 1] === 'install' &&
    parts[bunGlobalIdx + 2] === 'global' &&
    parts[bunGlobalIdx + 3] === 'node_modules'
  ) {
    return 'bun'
  }

  // pnpm shards globals under a numeric major-version segment, e.g.
  // ~/Library/pnpm/global/5/node_modules or legacy ~/.pnpm-global/5/node_modules.
  if (nodeModulesIdx >= 2 && /^\d+$/.test(parts[nodeModulesIdx - 1] ?? '')) {
    const anchor = parts[nodeModulesIdx - 2]
    if (anchor === 'pnpm-global' || anchor === '.pnpm-global') return 'pnpm'
    if (anchor === 'global' && parts[nodeModulesIdx - 3] === 'pnpm') return 'pnpm'
  }

  if (nodeModulesIdx >= 2 && parts[nodeModulesIdx - 1] === 'global' && parts[nodeModulesIdx - 2] === 'yarn') {
    return 'yarn'
  }

  if (parts[nodeModulesIdx - 1] === 'lib') return 'npm'
  return null
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}
