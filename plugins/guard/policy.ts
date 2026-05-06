export const ACKNOWLEDGE_GUARDS = 'acknowledgeGuards'

export type GuardBlock = { block: true; reason: string }

export function isGuardAcknowledged(args: Record<string, unknown>, guard: string): boolean {
  const acknowledgements = args[ACKNOWLEDGE_GUARDS]
  if (!acknowledgements || typeof acknowledgements !== 'object') return false
  return (acknowledgements as Record<string, unknown>)[guard] === true
}

export { GUARD_NON_WORKSPACE_WRITE, checkNonWorkspaceWriteGuard } from './policies/non-workspace-write'
