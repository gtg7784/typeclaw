import { randomBytes } from 'node:crypto'

// Role-claim codes are short, human-typeable tokens the operator sends from
// their host CLI to the bot in any chat (DM, group, channel) to prove
// ownership of that channel identity. Shape: `claim-XXXX-YYYY` where each
// block is 4 chars from a Crockford-style base32 alphabet (0-9 + A-Z minus
// I, L, O, U to dodge OCR-confusable / profane shapes). 8 chars * 5 bits =
// 40 bits of entropy, which is overkill for a TTL'd in-memory window but
// cheap to display and dictate over voice.
//
// The `claim-` prefix lets the channel router recognize potential claim
// attempts in inbound text without scanning the whole body for hex blocks,
// and distinguishes claim messages from normal first-message text like
// "hi" which would otherwise need a regex of its own to disambiguate.

export const CLAIM_CODE_PREFIX = 'claim-'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BLOCK_SIZE = 4
const BLOCK_COUNT = 2

export function generateClaimCode(): string {
  const bytes = randomBytes(BLOCK_SIZE * BLOCK_COUNT)
  const chars: string[] = []
  for (let i = 0; i < bytes.length; i++) {
    chars.push(ALPHABET[bytes[i]! % ALPHABET.length]!)
  }
  const blocks: string[] = []
  for (let b = 0; b < BLOCK_COUNT; b++) {
    blocks.push(chars.slice(b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE).join(''))
  }
  return `${CLAIM_CODE_PREFIX}${blocks.join('-')}`
}

// Extracts the first claim-code-shaped token from inbound text. Returns
// the canonical-case (upper) code, or null. Tolerates surrounding
// whitespace, punctuation, and case — chat clients may auto-correct case
// or surround pastes with quotes/backticks.
export function extractClaimCode(text: string): string | null {
  const pattern = new RegExp(
    `${CLAIM_CODE_PREFIX}([0-9a-zA-Z]{${BLOCK_SIZE}}(?:-[0-9a-zA-Z]{${BLOCK_SIZE}}){${BLOCK_COUNT - 1}})`,
    'i',
  )
  const match = pattern.exec(text)
  if (!match) return null
  return `${CLAIM_CODE_PREFIX}${match[1]!.toUpperCase()}`
}

export function normalizeClaimCode(code: string): string {
  const trimmed = code.trim()
  if (!trimmed.toLowerCase().startsWith(CLAIM_CODE_PREFIX)) return trimmed.toUpperCase()
  return `${CLAIM_CODE_PREFIX}${trimmed.slice(CLAIM_CODE_PREFIX.length).toUpperCase()}`
}
