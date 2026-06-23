export { isDaemonReachable, send } from './client'
export { startDaemon, type Daemon, type DaemonLogEvent, type DaemonOptions } from './daemon'
export {
  ensureDirs,
  homeRoot,
  lockfilePath,
  logDir,
  logfilePath,
  pidfilePath,
  runDir,
  socketPath,
  versionCachePath,
} from './paths'
export type {
  ListResult,
  Request,
  Response,
  RestartResult,
  ShutdownResult,
  StatusResult,
  VersionResult,
} from './protocol'
export { ensureDaemon, type EnsureDaemonOptions, type EnsureDaemonResult } from './spawn'
export type { SupervisorOptions } from './supervisor'
export { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL, type SourceVersion } from './version'
