import { type TeamsAccountRecord, type TeamsChannelBlock, teamsChannelBlockSchema } from './schema'
import type { RuntimeSecretsProvider } from './secrets-provider'
import { SecretsBackend } from './storage'

export type SetTeamsAccountInput = TeamsAccountRecord

export type SecretsTeamsCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostProvider: RuntimeSecretsProvider }

const EMPTY_BLOCK: TeamsChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsTeamsCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsTeamsCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async getAccount(id?: string): Promise<TeamsAccountRecord | null> {
    const block = this.readBlock()
    const accountId = id ?? block.currentAccount
    if (!accountId) return null
    return block.accounts[accountId] ?? null
  }

  async setAccount(account: SetTeamsAccountInput): Promise<void> {
    await this.writeBlock((block) => {
      const merged = mergeAccountPreservingRefreshFields(account, block.accounts[account.account_id])
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

  async listAccounts(): Promise<Array<TeamsAccountRecord & { is_current: boolean }>> {
    const block = this.readBlock()
    return Object.values(block.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === block.currentAccount,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): TeamsChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.options.hostProvider.readChannels() : this.backend.readChannelsSync()
    return parseBlock(channels?.teams)
  }

  private async writeBlock(update: (current: TeamsChannelBlock) => TeamsChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        await this.options.hostProvider.writeBackChannelBlock({ teams: next })
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, teams: update(parseBlock(channels.teams)) }
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

function parseBlock(value: unknown): TeamsChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return teamsChannelBlockSchema.parse(value)
}

// A silent-refresh write (new access token from the stored refresh token)
// carries only the freshly minted access fields; the AAD refresh trio it was
// minted from must survive so the NEXT refresh still has something to spend.
function mergeAccountPreservingRefreshFields(
  incoming: SetTeamsAccountInput,
  priorOnDisk: TeamsChannelBlock['accounts'][string] | undefined,
): TeamsAccountRecord {
  const merged: TeamsAccountRecord = { ...incoming }
  if (incoming.aad_refresh_token === undefined && priorOnDisk?.aad_refresh_token !== undefined) {
    merged.aad_refresh_token = priorOnDisk.aad_refresh_token
  }
  if (incoming.aad_client_id === undefined && priorOnDisk?.aad_client_id !== undefined) {
    merged.aad_client_id = priorOnDisk.aad_client_id
  }
  if (incoming.aad_tenant_id === undefined && priorOnDisk?.aad_tenant_id !== undefined) {
    merged.aad_tenant_id = priorOnDisk.aad_tenant_id
  }
  return merged
}
