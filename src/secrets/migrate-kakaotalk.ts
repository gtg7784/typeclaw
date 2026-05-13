import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'

import { KakaoCredentialManager } from 'agent-messenger/kakaotalk'

import { SecretsKakaoCredentialStore } from './kakao-store'
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
  const existing = parseExistingBlock(new SecretsBackend(secretsPath).readChannelsSync().kakaotalk)
  if (!isEmptyBlock(existing)) return { promoted: false }

  const legacy = new KakaoCredentialManager(configDir)
  const config = await legacy.load()
  const pendingLogin = await legacy.loadPendingLogin()
  if (Object.keys(config.accounts).length === 0 && pendingLogin === null) return { promoted: false }

  const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath })
  await store.save(config)
  if (pendingLogin) await store.savePendingLogin(pendingLogin)

  await renameIfPresent(credentialsPath, `${credentialsPath}.migrated`)
  await renameIfPresent(pendingLoginPath, `${pendingLoginPath}.migrated`)
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

async function renameIfPresent(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return
  await rename(from, to)
}
