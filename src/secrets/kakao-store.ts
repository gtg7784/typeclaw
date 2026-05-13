import type { KakaoAccountCredentials, KakaoConfig } from 'agent-messenger/kakaotalk'
import type { PendingLoginState } from 'agent-messenger/kakaotalk'

import { sendHttp } from '@/hostd/client'

import { type KakaoChannelBlock, kakaoChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'

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
    await this.writeBlock(() => fromKakaoConfig(config))
  }

  async getAccount(id?: string): Promise<KakaoAccountCredentials | null> {
    const config = await this.load()
    if (id) return config.accounts[id] ?? null
    if (!config.current_account) return null
    return config.accounts[config.current_account] ?? null
  }

  async setAccount(account: KakaoAccountCredentials): Promise<void> {
    await this.writeBlock((block) => {
      const accounts = { ...block.accounts, [account.account_id]: account }
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

function fromKakaoConfig(config: KakaoConfig): KakaoChannelBlock {
  return { currentAccount: config.current_account, accounts: config.accounts }
}
