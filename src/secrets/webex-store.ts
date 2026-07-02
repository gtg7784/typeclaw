import { type WebexAccountRecord, type WebexChannelBlock, webexChannelBlockSchema } from './schema'
import type { RuntimeSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

export type SetWebexAccountInput = WebexAccountRecord

export type SecretsWebexCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostProvider: RuntimeSecretsProvider }

const EMPTY_BLOCK: WebexChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsWebexCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsWebexCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async getAccount(id?: string): Promise<WebexAccountRecord | null> {
    const block = this.readBlock()
    const accountId = id ?? block.currentAccount
    if (!accountId) return null
    return block.accounts[accountId] ?? null
  }

  async getAccountWithRenewalFields(id?: string): Promise<WebexAccountRecord | null> {
    return await this.getAccount(id)
  }

  async setAccount(account: SetWebexAccountInput): Promise<void> {
    await this.writeBlock((block) => {
      const merged = mergeAccountPreservingRenewalFields(account, block.accounts[account.account_id])
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

  async listAccounts(): Promise<Array<WebexAccountRecord & { is_current: boolean }>> {
    const block = this.readBlock()
    return Object.values(block.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === block.currentAccount,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): WebexChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    return parseBlock(channels?.webex)
  }

  private async writeBlock(update: (current: WebexChannelBlock) => WebexChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        await this.options.hostProvider.writeBackChannelBlock({ webex: next })
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, webex: update(parseBlock(channels.webex)) }
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

function parseBlock(value: unknown): WebexChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return webexChannelBlockSchema.parse(value)
}

function mergeAccountPreservingRenewalFields(
  incoming: SetWebexAccountInput,
  priorOnDisk: WebexChannelBlock['accounts'][string] | undefined,
): WebexAccountRecord {
  const merged: WebexAccountRecord = { ...incoming }
  if (incoming.email !== undefined) merged.email = incoming.email
  else if (priorOnDisk?.email !== undefined) merged.email = priorOnDisk.email
  if (incoming.encryptedPassword !== undefined) merged.encryptedPassword = incoming.encryptedPassword
  else if (priorOnDisk?.encryptedPassword !== undefined) merged.encryptedPassword = priorOnDisk.encryptedPassword
  return merged
}
