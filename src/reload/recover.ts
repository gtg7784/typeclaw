import { ReloadConnectionError, requestReload } from './client'
import { requestReloadViaDockerExec } from './docker-exec-client'
import type { ReloadResult } from './types'

export type RequestReloadWithFallbackOptions = {
  url: string
  cwd?: string
  token?: string | null
  scope?: string
  timeoutMs?: number
  reload?: typeof requestReload
  reloadViaDockerExec?: typeof requestReloadViaDockerExec
}

export type RequestReloadWithFallbackResult =
  | { transport: 'host'; results: ReloadResult[] }
  | { transport: 'container-local'; results: ReloadResult[]; hostError: string }

export async function requestReloadWithFallback({
  url,
  cwd,
  token,
  scope,
  timeoutMs,
  reload = requestReload,
  reloadViaDockerExec = requestReloadViaDockerExec,
}: RequestReloadWithFallbackOptions): Promise<RequestReloadWithFallbackResult> {
  try {
    return { transport: 'host', results: await reload({ url, scope, timeoutMs }) }
  } catch (err) {
    if (!(err instanceof ReloadConnectionError) || cwd === undefined || token === undefined) throw err
    return {
      transport: 'container-local',
      results: await reloadViaDockerExec({ cwd, token, scope, timeoutMs }),
      hostError: err.message,
    }
  }
}
