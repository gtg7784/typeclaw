import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'

import { KakaoCredentialManager } from 'agent-messenger/kakaotalk'
import type { KakaoConfig, PendingLoginState } from 'agent-messenger/kakaotalk'

import { type KakaoChannelBlock, kakaoChannelBlockSchema } from './schema'
import { SecretsBackend } from './storage'

const KAKAO_CONFIG_DIR = join('workspace', '.agent-messenger')
const CREDENTIALS_FILE = 'kakaotalk-credentials.json'
const PENDING_LOGIN_FILE = 'kakaotalk-pending-login.json'

export type KakaotalkCredentialMigrationResult = { promoted: boolean }

export async function migrateKakaotalkCredentials(agentDir: string): Promise<KakaotalkCredentialMigrationResult> {
  const configDir = join(agentDir, KAKAO_CONFIG_DIR)
  const credentialsPath = join(configDir, CREDENTIALS_FILE)
  const pendingLoginPath = join(configDir, PENDING_LOGIN_FILE)
  if (!existsSync(credentialsPath) && !existsSync(pendingLoginPath)) return { promoted: false }

  const secretsPath = join(agentDir, 'secrets.json')
  const legacy = new KakaoCredentialManager(configDir)
  const config = await legacy.load()
  const pendingLogin = await legacy.loadPendingLogin()
  if (Object.keys(config.accounts).length === 0 && pendingLogin === null) return { promoted: false }

  const backend = new SecretsBackend(secretsPath)
  const result = await backend.updateChannelsAsync(async (channels) => {
    const existing = parseExistingBlock(channels.kakaotalk)
    const next = mergeLegacyBlock(existing, config, pendingLogin)
    if (next === existing) return { result: { promoted: false, renameCredentials: false, renamePending: false } }

    return {
      result: {
        promoted: true,
        renameCredentials: isEmptyBlock(existing) && Object.keys(config.accounts).length > 0,
        renamePending: pendingLogin !== null && existing?.pendingLogin === undefined,
      },
      next: { ...channels, kakaotalk: next },
    }
  })
  if (!result.promoted) return { promoted: false }

  if (result.renameCredentials) await renameIfPresent(credentialsPath, `${credentialsPath}.migrated`)
  if (result.renamePending) await renameIfPresent(pendingLoginPath, `${pendingLoginPath}.migrated`)
  return { promoted: true }
}

function parseExistingBlock(value: unknown): KakaoChannelBlock | null {
  if (value === undefined) return null
  return kakaoChannelBlockSchema.parse(value)
}

function isEmptyBlock(block: KakaoChannelBlock | null): boolean {
  return (
    block === null ||
    (block.currentAccount === null && Object.keys(block.accounts).length === 0 && block.pendingLogin === undefined)
  )
}

function mergeLegacyBlock(
  existing: KakaoChannelBlock | null,
  config: KakaoConfig,
  pendingLogin: PendingLoginState | null,
): KakaoChannelBlock | null {
  if (existing === null || isEmptyBlock(existing)) {
    return {
      currentAccount: config.current_account,
      accounts: config.accounts,
      ...(pendingLogin ? { pendingLogin } : {}),
    }
  }
  if (pendingLogin === null || existing.pendingLogin !== undefined) return existing
  return { ...existing, pendingLogin }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return
  await rename(from, to)
}
