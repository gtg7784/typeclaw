const CJK_LANGUAGE_PREFIXES = ['ja', 'ko', 'zh'] as const

function languageTagIsCjk(tag: string): boolean {
  const primary = tag.toLowerCase().replace(/_/g, '-').split('-')[0] ?? ''
  return CJK_LANGUAGE_PREFIXES.some((prefix) => primary === prefix)
}

// True when the HOST's locale is Chinese/Japanese/Korean. POSIX precedence:
// LC_ALL overrides LC_CTYPE overrides LANG. Values look like `ja_JP.UTF-8`,
// `ko_KR`, `zh-Hans`. `C`/`POSIX`/empty fall through to Intl, which on macOS
// (where these env vars are usually unset) reports the user's system locale.
// Returns false if nothing resolves — the conservative choice, since the
// caller uses this to decide whether to add the ~89MB CJK font package.
export function hostLocaleIsCjk(): boolean {
  for (const envVar of ['LC_ALL', 'LC_CTYPE', 'LANG']) {
    const value = process.env[envVar]
    if (value === undefined || value === '') continue
    if (value === 'C' || value === 'POSIX') return false
    return languageTagIsCjk(value)
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    return locale !== undefined && locale !== '' && languageTagIsCjk(locale)
  } catch {
    return false
  }
}
