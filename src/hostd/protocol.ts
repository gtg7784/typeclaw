export type Request =
  | {
      kind: 'register'
      containerName: string
      cwd: string
      restartToken?: string
    }
  | { kind: 'deregister'; containerName: string }
  | { kind: 'list' }
  | { kind: 'status'; containerName: string }
  | { kind: 'restart'; containerName: string }
  | { kind: 'http-info' }
  | { kind: 'version' }
  | { kind: 'shutdown' }

export type Response = { ok: true; result?: unknown } | { ok: false; reason: string }

export type ListResult = {
  registrations: Array<{ containerName: string; cwd: string }>
}

export type StatusResult = {
  containerName: string
  cwd: string
}

export type RestartResult = {
  containerName: string
  scheduled: true
}

export type HttpInfoResult = {
  port: number
}

export type VersionResult = {
  version: string
}

export type ShutdownResult = {
  scheduled: true
}
