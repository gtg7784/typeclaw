import { z } from 'zod'

import { loadPluginConfigsSync } from '@/config'

export const vectorConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false })

export type VectorConfig = z.infer<typeof vectorConfigSchema>

// Fails closed to `false`: a memory block we can't parse is treated as opted
// out. Shared by the host-side download gate and the runtime's per-turn vs
// system-prompt memory-injection decision, so both read the flag identically.
export function vectorEnabledFromMemoryConfig(memory: unknown): boolean {
  if (typeof memory !== 'object' || memory === null) return false
  const parsed = vectorConfigSchema.safeParse((memory as Record<string, unknown>).vector)
  return parsed.success && parsed.data.enabled
}

export function agentUsesVector(cwd: string): boolean {
  try {
    return vectorEnabledFromMemoryConfig(loadPluginConfigsSync(cwd).memory)
  } catch {
    return false
  }
}
