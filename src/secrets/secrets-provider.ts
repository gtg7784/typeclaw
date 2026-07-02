import { sendHttp } from '@/hostd/client'
import type { Request } from '@/hostd/protocol'

// The channel-block payload a container-mode store hands off to be persisted.
// Identical to the `secrets-patch` RPC's `patch.channels` union so the hostd
// implementation forwards it verbatim — the on-the-wire contract is unchanged
// by this abstraction.
export type ChannelBlockPatch = Extract<Request, { kind: 'secrets-patch' }>['patch']['channels']

// The container-stage secrets write-back seam. The container cannot write the
// (host-owned) secrets.json directly, so credential stores delegate write-back
// through this. Named for what the runtime NEEDS, not the transport that serves
// it: today hostd (HTTP RPC), tomorrow a persistent volume or a platform secret
// store — all behind the same method.
export interface RuntimeSecretsProvider {
  writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void>
}

export type HostdSecretsProviderOptions = {
  hostdUrl: string
  restartToken: string
  containerName: string
}

// Wraps today's behavior: a `secrets-patch` RPC over HTTP to hostd
// (host.docker.internal), Bearer-authed by the per-container restart token.
export function createHostdSecretsProvider(options: HostdSecretsProviderOptions): RuntimeSecretsProvider {
  return {
    async writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void> {
      const response = await sendHttp(
        { kind: 'secrets-patch', containerName: options.containerName, patch: { channels } },
        { url: options.hostdUrl, token: options.restartToken },
      )
      if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
    },
  }
}

// Resolves the container-stage write-back provider from the environment. Returns
// null when the hostd triple is absent (daemon unreachable at launch, or a
// managed profile with no write-back wired yet) — callers degrade gracefully
// rather than crash. Today only the hostd-backed provider exists; a managed
// impl (volume / secret store) is selected here when it lands.
export function resolveRuntimeSecretsProvider(env: NodeJS.ProcessEnv): RuntimeSecretsProvider | null {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) return null
  return createHostdSecretsProvider({ hostdUrl, restartToken, containerName })
}
