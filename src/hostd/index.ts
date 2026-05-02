export { isDaemonReachable, send } from './client'
export { startDaemon, type Daemon, type DaemonLogEvent, type DaemonOptions } from './daemon'
export {
  containerSocketPath,
  ensureDirs,
  homeRoot,
  lockfilePath,
  logDir,
  logfilePath,
  pidfilePath,
  runDir,
  socketPath,
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
