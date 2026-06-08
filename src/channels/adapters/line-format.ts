import { toKakaoPlainText } from './kakaotalk-format'

// LINE chat renders no rich text, exactly like KakaoTalk's LOCO surface:
// `**bold**`, `### headings`, `| tables |`, and fenced code blocks all show
// their literal markers. The markdown-stripping rules are identical, so this
// reuses the KakaoTalk stripper rather than maintaining a second copy that
// would drift. If LINE ever grows a formatting quirk KakaoTalk lacks, fork the
// implementation here.
export function toLinePlainText(input: string): string {
  return toKakaoPlainText(input)
}
