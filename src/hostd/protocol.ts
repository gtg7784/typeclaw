export type Request =
  | {
      kind: 'register'
      containerName: string
      cwd: string
      excludePorts?: number[]
      // When true, the daemon tracks the (containerName, cwd) pair so future
      // capabilities can resolve the agent folder, but skips starting a
      // port-forwarding broker. Used when typeclaw.json sets autoForward: false.
      disableForwarding?: boolean
    }
  | { kind: 'deregister'; containerName: string }
  | { kind: 'list' }
  | { kind: 'status'; containerName: string }
  | { kind: 'restart'; containerName: string }

export type Response = { ok: true; result?: unknown } | { ok: false; reason: string }

export type ListResult = {
  brokers: Array<{ containerName: string; forwardedPorts: number[]; containerIp: string }>
}

export type StatusResult = {
  containerName: string
  containerIp: string
  forwardedPorts: number[]
}

export type RestartResult = {
  containerName: string
  scheduled: true
}
