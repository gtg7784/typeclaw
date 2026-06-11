import { z } from 'zod'

export const vectorConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false })

export type VectorConfig = z.infer<typeof vectorConfigSchema>
