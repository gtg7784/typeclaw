export { discoverAgents, type AgentEntry } from './discover'
export {
  composeDoctor,
  runCrossChecks,
  type ComposeDoctorAgent,
  type ComposeDoctorCrossCheck,
  type ComposeDoctorOptions,
  type ComposeDoctorReport,
} from './doctor'
export { colorFor, composeLogs, makeLinePrefixer, type ComposeLogsOptions, type ComposeLogsResult } from './logs'
export { composeStatus, type AgentRuntimeState, type AgentStatusEntry, type ComposeStatusResult } from './status'
export {
  composeRestart,
  type ComposeRestartEvent,
  type ComposeRestartOptions,
  type ComposeRestartResult,
  type RestartData,
} from './restart'
export {
  composeStart,
  type AgentResult,
  type ComposeStartEvent,
  type ComposeStartOptions,
  type ComposeStartResult,
  type StartSuccess,
} from './start'
export {
  composeStop,
  type ComposeStopEvent,
  type ComposeStopOptions,
  type ComposeStopResult,
  type StopSuccess,
} from './stop'
