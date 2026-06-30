import { toKakaoPlainText } from './kakaotalk-format'

// Instagram DMs render plain text like KakaoTalk and LINE: markdown markers are
// visible to recipients, so reuse the existing plain-text stripper until the SDK
// exposes a platform-specific rich-text surface.
export function toInstagramPlainText(input: string): string {
  return toKakaoPlainText(input)
}
