export type Request =
  | { kind: 'register'; containerName: string; cwd: string }
  | { kind: 'deregister'; containerName: string }
  | { kind: 'list' }
  | { kind: 'status'; containerName: string }

export type Response = { ok: true; result?: unknown } | { ok: false; reason: string }

export type ListResult = {
  brokers: Array<{ containerName: string; forwardedPorts: number[]; containerIp: string }>
}

export type StatusResult = {
  containerName: string
  containerIp: string
  forwardedPorts: number[]
}
