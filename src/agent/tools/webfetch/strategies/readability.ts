import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
})
turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0]

export function applyReadability(html: string, url: string): string {
  const dom = new JSDOM(html, { url })
  const document = dom.window.document.cloneNode(true) as unknown as ReadabilityDocument
  const article = new Readability(document).parse()

  const source = article?.content?.trim() ? article.content : html
  const markdown = turndown.turndown(source).trim()

  if (!markdown) return 'Readability extracted no content from this page.'

  if (article?.title) {
    return `# ${article.title}\n\n${markdown}`
  }
  return markdown
}
