import { detectSecrets } from './secret-detector'

export const MAX_PROVENANCE_NAME_LENGTH = 256

export function sanitizeProvenanceName(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_PROVENANCE_NAME_LENGTH) return undefined
  if (hasUnsafeUnicode(value) || hasMarkdownPromptShaping(value) || detectSecrets(value).length > 0) return undefined
  return value
}

export function isSafeProvenanceCoordinate(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PROVENANCE_NAME_LENGTH && !hasUnsafeUnicode(value)
}

function hasUnsafeUnicode(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
    if (codePoint === 0x00ad || codePoint === 0x034f || codePoint === 0x180e) return true
    if (codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f) return true
    if (codePoint >= 0x2028 && codePoint <= 0x202e) return true
    if (codePoint >= 0x2061 && codePoint <= 0x2064) return true
    if (codePoint >= 0x2066 && codePoint <= 0x2069) return true
    if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d) return true
    if (codePoint === 0x2060 || codePoint === 0xfeff) return true
    if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true
  }
  return false
}

function hasMarkdownPromptShaping(value: string): boolean {
  if (['`', '*', '_', '[', ']', '<', '>', '|', '\\'].some((character) => value.includes(character))) return true
  if (value.includes('__') || value.includes('![')) return true
  const trimmed = value.trimStart()
  if (trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('---')) return true
  if (trimmed.startsWith('- ') || trimmed.startsWith('+ ')) return true
  if (/^\d{1,9}[.)]\s/u.test(trimmed)) return true
  return false
}
