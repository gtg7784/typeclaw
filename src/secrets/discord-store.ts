import { type DiscordAccountRecord, type DiscordChannelBlock, discordChannelBlockSchema } from './schema'
import type { RuntimeSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

export type SetDiscordAccountInput = DiscordAccountRecord

export type SecretsDiscordCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostProvider: RuntimeSecretsProvider }

const EMPTY_BLOCK: DiscordChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsDiscordCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsDiscordCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async getAccount(id?: string): Promise<DiscordAccountRecord | null> {
    const block = this.readBlock()
    const accountId = id ?? block.currentAccount
    if (!accountId) return null
    return block.accounts[accountId] ?? null
  }

  async setAccount(account: SetDiscordAccountInput): Promise<void> {
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

  async listAccounts(): Promise<Array<DiscordAccountRecord & { is_current: boolean }>> {
    const block = this.readBlock()
    return Object.values(block.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === block.currentAccount,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): DiscordChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    return parseBlock(channels?.discord)
  }

  private async writeBlock(update: (current: DiscordChannelBlock) => DiscordChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        await this.options.hostProvider.writeBackChannelBlock({ discord: next })
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, discord: update(parseBlock(channels.discord)) }
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

function parseBlock(value: unknown): DiscordChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return discordChannelBlockSchema.parse(value)
}
