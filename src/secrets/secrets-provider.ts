import { sendHttp } from '@/hostd/client'
import type { SecretsPatchChannels } from '@/hostd/protocol'

import type { Channels } from './schema'
import { SecretsBackend } from './storage'

// The channel-block payload a container-mode store hands off to be persisted.
// Identical to the `secrets-patch` RPC's `patch.channels` union so the hostd
// implementation forwards it verbatim — the on-the-wire contract is unchanged
// by this abstraction.
export type ChannelBlockPatch = SecretsPatchChannels

// The container-stage secrets seam. Named for what the runtime NEEDS, not the
// transport that serves it. Two halves:
//   read  — the whole channels slice (callers extract their own adapter block).
//           Returns null when secrets.json is absent, so callers degrade rather
//           than crash. File-based today (a mounted secrets.json); a managed
//           impl (volume / secret store) slots in behind the same method.
//   write — persist one adapter's block. The container cannot write the
//           host-owned file directly under hostd, so this may cross a transport
//           (secrets-patch RPC); under a volume it's a direct file write.
export interface RuntimeSecretsProvider {
  readChannels(): Channels | null
  writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void>
}

export type HostdSecretsProviderOptions = {
  hostdUrl: string
  restartToken: string
  containerName: string
  // The mounted secrets.json the container READS from. Writes go through hostd
  // (secrets-patch RPC) to avoid concurrent-writer corruption; reads are the
  // live bind-mounted file, so this path is needed here.
  secretsPath: string
}

// The container-under-hostd provider: reads the mounted secrets.json directly,
// writes back via a `secrets-patch` RPC over HTTP to hostd (host.docker.internal),
// Bearer-authed by the per-container restart token.
export function createHostdSecretsProvider(options: HostdSecretsProviderOptions): RuntimeSecretsProvider {
  const backend = new SecretsBackend(options.secretsPath)
  return {
    readChannels(): Channels | null {
      return backend.tryReadChannelsSync()
    },
    async writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void> {
      const response = await sendHttp(
        { kind: 'secrets-patch', containerName: options.containerName, patch: { channels } },
        { url: options.hostdUrl, token: options.restartToken },
      )
      if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
    },
  }
}

// The file-backed provider: both halves hit the secrets.json on disk directly.
// Used where the runtime owns the file (a mounted volume in a future managed
// profile, or host-stage). No transport — writes merge the block into the file
// under the same lock the reads use.
export function createFileSecretsProvider(secretsPath: string): RuntimeSecretsProvider {
  const backend = new SecretsBackend(secretsPath)
  return {
    readChannels(): Channels | null {
      return backend.tryReadChannelsSync()
    },
    async writeBackChannelBlock(patch: ChannelBlockPatch): Promise<void> {
      await backend.updateChannelsAsync(async (channels) => ({ result: undefined, next: { ...channels, ...patch } }))
    },
  }
}

// Resolves the container-stage secrets provider from the environment. Returns
// null when the hostd triple is absent (daemon unreachable at launch, or a
// managed profile with no write-back wired yet) — callers degrade gracefully
// rather than crash. Today only the hostd-backed provider exists; a managed
// impl (volume / secret store) is selected here when it lands.
export function resolveRuntimeSecretsProvider(
  env: NodeJS.ProcessEnv,
  secretsPath: string,
): RuntimeSecretsProvider | null {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) return null
  return createHostdSecretsProvider({ hostdUrl, restartToken, containerName, secretsPath })
}
