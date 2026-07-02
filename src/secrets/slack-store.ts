import { type SlackAccountRecord, type SlackChannelBlock, slackChannelBlockSchema } from './schema'
import type { RuntimeSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

export type SetSlackAccountInput = SlackAccountRecord

export type SecretsSlackCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostProvider: RuntimeSecretsProvider }

const EMPTY_BLOCK: SlackChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsSlackCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsSlackCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async getAccount(id?: string): Promise<SlackAccountRecord | null> {
    const block = this.readBlock()
    const accountId = id ?? block.currentAccount
    if (!accountId) return null
    return block.accounts[accountId] ?? null
  }

  async setAccount(account: SetSlackAccountInput): Promise<void> {
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

  async listAccounts(): Promise<Array<SlackAccountRecord & { is_current: boolean }>> {
    const block = this.readBlock()
    return Object.values(block.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === block.currentAccount,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): SlackChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    return parseBlock(channels?.slack)
  }

  private async writeBlock(update: (current: SlackChannelBlock) => SlackChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        await this.options.hostProvider.writeBackChannelBlock({ slack: next })
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, slack: update(parseBlock(channels.slack)) }
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

function parseBlock(value: unknown): SlackChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return slackChannelBlockSchema.parse(value)
}
