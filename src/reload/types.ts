export type ReloadResult =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type Reloadable = {
  scope: string
  description: string
  reload: () => Promise<ReloadResult>
}

export type ReloadAllResult = {
  results: ReloadResult[]
}
