const HOOKLESS_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null'] as const

export function hooklessGitArgs(args: readonly string[]): string[] {
  return [...HOOKLESS_GIT_CONFIG, ...args]
}
