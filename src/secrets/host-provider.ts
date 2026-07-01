import { sendHttp } from '@/hostd/client'
import type { Request } from '@/hostd/protocol'

// The channel-block payload a container-mode store hands the host to persist.
// Identical to the `secrets-patch` RPC's `patch.channels` union so the hostd
// implementation forwards it verbatim — the on-the-wire contract is unchanged
// by this abstraction.
export type ChannelBlockPatch = Extract<Request, { kind: 'secrets-patch' }>['patch']['channels']

// The host role's substrate-write seam: the container cannot write the
// (host-owned) secrets.json directly, so credential stores in container mode
// delegate write-back through a HostProvider. Today the only implementation
// routes through hostd; a future managed-platform implementation writes to a
// persistent volume or a platform secret store behind the same interface.
export interface HostProvider {
  writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void>
}

export type HostdHostProviderOptions = {
  hostdUrl: string
  restartToken: string
  containerName: string
}

// Wraps today's behavior: a `secrets-patch` RPC over HTTP to hostd
// (host.docker.internal), Bearer-authed by the per-container restart token.
export class HostdHostProvider implements HostProvider {
  constructor(private readonly options: HostdHostProviderOptions) {}

  async writeBackChannelBlock(channels: ChannelBlockPatch): Promise<void> {
    const response = await sendHttp(
      { kind: 'secrets-patch', containerName: this.options.containerName, patch: { channels } },
      { url: this.options.hostdUrl, token: this.options.restartToken },
    )
    if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
  }
}
