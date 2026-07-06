import type { PortForward } from '@/config'
import type {
  DiscordChannelBlock,
  InstagramChannelBlock,
  KakaoChannelBlock,
  LineChannelBlock,
  McpCredential,
  SlackChannelBlock,
  TeamsChannelBlock,
  WebexChannelBlock,
} from '@/secrets/schema'

export type SecretsPatchChannels =
  | { kakaotalk: KakaoChannelBlock }
  | { discord: DiscordChannelBlock }
  | { instagram: InstagramChannelBlock }
  | { line: LineChannelBlock }
  | { webex: WebexChannelBlock }
  | { teams: TeamsChannelBlock }
  | { slack: SlackChannelBlock }

export type SecretsPatchMcp = { server: string; credential: McpCredential }

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
      patch: { channels: SecretsPatchChannels; mcp?: never } | { mcp: SecretsPatchMcp; channels?: never }
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
