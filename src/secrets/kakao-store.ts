import type { KakaoAccountCredentials, KakaoConfig } from 'agent-messenger/kakaotalk'
import type { PendingLoginState } from 'agent-messenger/kakaotalk'

import { sendHttp } from '@/hostd/client'

import { type KakaoChannelBlock, type KakaoEncryptedPassword, kakaoChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'

// Account shape accepted by setAccount(). Extends the upstream
// KakaoAccountCredentials with the typeclaw-only renewal fields (email +
// encrypted password). Callers that don't care about renewal can pass the
// upstream slice unchanged; production's runKakaotalkBootstrap supplies the
// extra fields so the renewal cron can use them.
export type SetKakaoAccountInput = KakaoAccountCredentials & {
  email?: string
  encryptedPassword?: KakaoEncryptedPassword
}

export type SecretsKakaoCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostdUrl: string; restartToken: string; containerName: string }

const EMPTY_BLOCK: KakaoChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsKakaoCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsKakaoCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async load(): Promise<KakaoConfig> {
    return toKakaoConfig(this.readBlock())
  }

  async save(config: KakaoConfig): Promise<void> {
    await this.writeBlock((prior) => fromKakaoConfig(config, prior))
  }

  async getAccount(id?: string): Promise<KakaoAccountCredentials | null> {
    const config = await this.load()
    if (id) return config.accounts[id] ?? null
    if (!config.current_account) return null
    return config.accounts[config.current_account] ?? null
  }

  async setAccount(account: SetKakaoAccountInput): Promise<void> {
    await this.writeBlock((block) => {
      const merged = mergeUpstreamAccount(account, block.accounts[account.account_id])
      const accounts = { ...block.accounts, [account.account_id]: merged }
      return { ...block, currentAccount: block.currentAccount ?? account.account_id, accounts }
    })
  }

  async removeAccount(id: string): Promise<void> {
    await this.writeBlock((block) => {
      const accounts = { ...block.accounts }
      delete accounts[id]
      const currentAccount = block.currentAccount === id ? (Object.keys(accounts)[0] ?? null) : block.currentAccount
      return { ...block, currentAccount, accounts }
    })
  }

  async listAccounts(): Promise<Array<KakaoAccountCredentials & { is_current: boolean }>> {
    const config = await this.load()
    return Object.values(config.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === config.current_account,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  async savePendingLogin(state: PendingLoginState): Promise<void> {
    await this.writeBlock((block) => ({ ...block, pendingLogin: state }))
  }

  async loadPendingLogin(): Promise<PendingLoginState | null> {
    return this.readBlock().pendingLogin ?? null
  }

  async clearPendingLogin(): Promise<void> {
    await this.writeBlock((block) => {
      const { pendingLogin: _pendingLogin, ...next } = block
      return next
    })
  }

  private readBlock(): KakaoChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    const raw = channels?.kakaotalk
    return parseBlock(raw)
  }

  private async writeBlock(update: (current: KakaoChannelBlock) => KakaoChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        const response = await sendHttp(
          {
            kind: 'secrets-patch',
            containerName: this.options.containerName,
            patch: { channels: { kakaotalk: next } },
          },
          { url: this.options.hostdUrl, token: this.options.restartToken },
        )
        if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, kakaotalk: update(parseBlock(channels.kakaotalk)) }
        return { result: undefined, next }
      })
    })
  }

  private enqueueWrite(op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(op, op)
    this.writeChain = next.catch(() => {})
    return next
  }
}

function parseBlock(value: unknown): KakaoChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return kakaoChannelBlockSchema.parse(value)
}

function toKakaoConfig(block: KakaoChannelBlock): KakaoConfig {
  return { current_account: block.currentAccount, accounts: block.accounts }
}

// The upstream KakaoConfig/KakaoAccountCredentials types have no awareness of
// `email` or `encryptedPassword`, so any SDK-driven round-trip (save() after
// token refresh, KakaoCredentialManager replacing a config slot) would strip
// them. Re-attach them per-account from the prior on-disk block, keyed by
// account_id, so token rotations preserve the renewal credentials the cron
// depends on.
function fromKakaoConfig(config: KakaoConfig, prior: KakaoChannelBlock): KakaoChannelBlock {
  const accounts: KakaoChannelBlock['accounts'] = {}
  for (const [id, account] of Object.entries(config.accounts)) {
    accounts[id] = mergeUpstreamAccount(account, prior.accounts[id])
  }
  return { ...prior, currentAccount: config.current_account, accounts }
}

function mergeUpstreamAccount(
  incoming: SetKakaoAccountInput | KakaoAccountCredentials,
  priorOnDisk: KakaoChannelBlock['accounts'][string] | undefined,
): KakaoChannelBlock['accounts'][string] {
  const incomingExt = incoming as SetKakaoAccountInput
  const merged: KakaoChannelBlock['accounts'][string] = { ...incoming }
  // Incoming wins for fields it explicitly carries (e.g. fresh login provides
  // email + encryptedPassword); otherwise we fall back to the prior on-disk
  // record so token-refresh round-trips through the SDK don't strip our
  // renewal credentials.
  if (incomingExt.email !== undefined) merged.email = incomingExt.email
  else if (priorOnDisk?.email !== undefined) merged.email = priorOnDisk.email
  if (incomingExt.encryptedPassword !== undefined) merged.encryptedPassword = incomingExt.encryptedPassword
  else if (priorOnDisk?.encryptedPassword !== undefined) merged.encryptedPassword = priorOnDisk.encryptedPassword
  return merged
}
