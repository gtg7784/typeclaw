import { z } from 'zod'

export const fragmentEventSchema = z
  .object({
    type: z.literal('fragment'),
    id: z.string().min(1),
    ts: z.string().datetime(),
    source: z.string(),
    entry: z.string(),
    topic: z.string(),
    body: z.string(),
  })
  .passthrough()

export const watermarkEventSchema = z
  .object({
    type: z.literal('watermark'),
    id: z.string().min(1),
    ts: z.string().datetime(),
    source: z.string(),
    entry: z.string(),
  })
  .passthrough()

export const legacyProseEventSchema = z
  .object({
    type: z.literal('legacy_prose'),
    ts: z.string().datetime(),
    text: z.string(),
    origin: z.literal('migration'),
  })
  .passthrough()

export const streamEventSchema = z.discriminatedUnion('type', [
  fragmentEventSchema,
  watermarkEventSchema,
  legacyProseEventSchema,
])

export type FragmentEvent = z.infer<typeof fragmentEventSchema>
export type WatermarkEvent = z.infer<typeof watermarkEventSchema>
export type LegacyProseEvent = z.infer<typeof legacyProseEventSchema>
export type StreamEvent = FragmentEvent | WatermarkEvent | LegacyProseEvent

export function parseEventLine(line: string): StreamEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const result = streamEventSchema.safeParse(raw)
  if (!result.success) return null
  return result.data
}
