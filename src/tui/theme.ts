import type { EditorTheme, MarkdownTheme } from '@mariozechner/pi-tui'

const wrap = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`

const dim = wrap('2')
const bold = wrap('1')
const red = wrap('31')
const green = wrap('32')
const yellow = wrap('33')
const cyan = wrap('36')
const gray = wrap('90')

export const colors = { dim, bold, red, green, yellow, cyan, gray }

export const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: (text) => dim(`(${text})`),
  code: yellow,
  codeBlock: yellow,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
}
