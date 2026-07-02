import { type InstagramAccountRecord, type InstagramChannelBlock, instagramChannelBlockSchema } from './schema'
import type { RuntimeSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

export type SecretsInstagramCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostProvider: RuntimeSecretsProvider }

const EMPTY_BLOCK: InstagramChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsInstagramCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsInstagramCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async load(): Promise<InstagramConfig> {
    return toInstagramConfig(this.readBlock())
  }

  async save(config: InstagramConfig): Promise<void> {
    await this.writeBlock(() => fromInstagramConfig(config))
  }

  async getAccount(id?: string): Promise<InstagramAccountRecord | null> {
    const config = await this.load()
    if (id) return config.accounts[id] ?? null
    if (!config.current) return null
    return config.accounts[config.current] ?? null
  }

  async setAccount(account: InstagramAccountRecord): Promise<void> {
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

  async listAccounts(): Promise<Array<InstagramAccountRecord & { is_current: boolean }>> {
    const config = await this.load()
    return Object.values(config.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === config.current,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): InstagramChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    return parseBlock(channels?.instagram)
  }

  private async writeBlock(update: (current: InstagramChannelBlock) => InstagramChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        await this.options.hostProvider.writeBackChannelBlock({ instagram: next })
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, instagram: update(parseBlock(channels.instagram)) }
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

function parseBlock(value: unknown): InstagramChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return instagramChannelBlockSchema.parse(value)
}

export type InstagramConfig = { current: string | null; accounts: Record<string, InstagramAccountRecord> }

function toInstagramConfig(block: InstagramChannelBlock): InstagramConfig {
  return { current: block.currentAccount, accounts: block.accounts }
}

function fromInstagramConfig(config: InstagramConfig): InstagramChannelBlock {
  return { currentAccount: config.current, accounts: config.accounts }
}
