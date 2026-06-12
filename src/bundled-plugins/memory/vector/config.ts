import { z } from 'zod'

import { loadPluginConfigsSync } from '@/config'

export const vectorConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false })

export type VectorConfig = z.infer<typeof vectorConfigSchema>

// Fails closed to `false`: a config we can't read/parse is treated as opted out,
// so the ~280 MB model download never fires for an agent we can't prove wants
// it. The container-side index build is the fail-loud gate if it's truly needed.
export function agentUsesVector(cwd: string): boolean {
  try {
    const memory = loadPluginConfigsSync(cwd).memory
    if (typeof memory !== 'object' || memory === null) return false
    const parsed = vectorConfigSchema.safeParse((memory as Record<string, unknown>).vector)
    return parsed.success && parsed.data.enabled
  } catch {
    return false
  }
}
