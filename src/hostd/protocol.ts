import type { PortForward } from '@/config'
import type { KakaoChannelBlock, LineChannelBlock, WebexChannelBlock } from '@/secrets/schema'

export type Request =
  | {
      kind: 'register'
      containerName: string
      cwd: string
      restartToken?: string
      wsHostPort?: number
      portForward?: PortForward
      brokerToken?: string
    }
  | { kind: 'deregister'; containerName: string }
  | { kind: 'list' }
  | { kind: 'status'; containerName: string }
  | { kind: 'restart'; containerName: string; build?: boolean }
  | {
      kind: 'secrets-patch'
      containerName: string
      patch: { channels: { kakaotalk: KakaoChannelBlock } | { line: LineChannelBlock } | { webex: WebexChannelBlock } }
    }
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
  forwardedPorts: number[]
}

export type RestartResult = {
  containerName: string
  scheduled: true
}

export type SecretsPatchResult = {
  containerName: string
  patched: true
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
