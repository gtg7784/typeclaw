export { buildSandboxedCommand, type SandboxedCommand } from './build'
export {
  canBindProcSafely,
  canMountRealProc,
  ensureBwrapAvailable,
  resolveProcSelfExe,
  _resetBwrapAvailabilityCacheForTests,
  _resetProcBindProbeCacheForTests,
  _resetRealProcProbeCacheForTests,
} from './availability'
export { resolveHiddenPaths, type HiddenPaths } from './hidden-paths'
export {
  resolveProtectedZones,
  resolveWritableZones,
  subtractMasked,
  type ProtectedZones,
  type WritableZones,
} from './writable-zones'
export { ensureSessionTmpDir, isUnderTmp, mapVirtualTmpPath, SESSION_TMP_ROOT, sessionTmpDir } from './session-tmp'
export { formatCommand, shellQuote } from './quote'
export { SandboxPolicyError, SandboxUnavailableError } from './errors'
export {
  DEFAULT_SANDBOX_ENV,
  type SandboxCommandFilter,
  type SandboxEnvPolicy,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxPolicy,
  type SandboxProcessPolicy,
  type SandboxProcStrategy,
  type SandboxProtectedPolicy,
  type SandboxWritablePolicy,
} from './policy'
