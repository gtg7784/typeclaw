import type { LineAccountCredentials, LineConfig } from 'agent-messenger/line'

import { sendHttp } from '@/hostd/client'

import { type LineChannelBlock, lineChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'

export type SecretsLineCredentialStoreOptions =
  | { mode: 'host'; secretsPath: string }
  | { mode: 'container'; secretsPath: string; hostdUrl: string; restartToken: string; containerName: string }

const EMPTY_BLOCK: LineChannelBlock = { currentAccount: null, accounts: {} }

export class SecretsLineCredentialStore {
  private readonly backend: SecretsBackend
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: SecretsLineCredentialStoreOptions) {
    this.backend = new SecretsBackend(options.secretsPath)
  }

  async load(): Promise<LineConfig> {
    return toLineConfig(this.readBlock())
  }

  async save(config: LineConfig): Promise<void> {
    await this.writeBlock(() => fromLineConfig(config))
  }

  async getAccount(id?: string): Promise<LineAccountCredentials | null> {
    const config = await this.load()
    if (id) return config.accounts[id] ?? null
    if (!config.current_account) return null
    return config.accounts[config.current_account] ?? null
  }

  async setAccount(account: LineAccountCredentials): Promise<void> {
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

  async listAccounts(): Promise<Array<LineAccountCredentials & { is_current: boolean }>> {
    const config = await this.load()
    return Object.values(config.accounts).map((account) => ({
      ...account,
      is_current: account.account_id === config.current_account,
    }))
  }

  async setCurrentAccount(id: string): Promise<void> {
    await this.writeBlock((block) => ({ ...block, currentAccount: id }))
  }

  private readBlock(): LineChannelBlock {
    const channels =
      this.options.mode === 'container' ? this.backend.tryReadChannelsSync() : this.backend.readChannelsSync()
    return parseBlock(channels?.line)
  }

  private async writeBlock(update: (current: LineChannelBlock) => LineChannelBlock): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.options.mode === 'container') {
        const next = update(this.readBlock())
        const response = await sendHttp(
          {
            kind: 'secrets-patch',
            containerName: this.options.containerName,
            patch: { channels: { line: next } },
          },
          { url: this.options.hostdUrl, token: this.options.restartToken },
        )
        if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
        return
      }

      await this.backend.updateChannelsAsync(async (channels) => {
        const next = { ...channels, line: update(parseBlock(channels.line)) }
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

function parseBlock(value: unknown): LineChannelBlock {
  if (value === undefined) return EMPTY_BLOCK
  return lineChannelBlockSchema.parse(value)
}

function toLineConfig(block: LineChannelBlock): LineConfig {
  return { current_account: block.currentAccount, accounts: block.accounts }
}

function fromLineConfig(config: LineConfig): LineChannelBlock {
  return { currentAccount: config.current_account, accounts: config.accounts }
}
