import * as cheerio from 'cheerio'

export class SelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorError'
  }
}

export function applySelector(html: string, selector: string): string {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SelectorError(`Failed to parse HTML: ${message}`)
  }

  let matches: cheerio.Cheerio<unknown>
  try {
    matches = $(selector) as unknown as cheerio.Cheerio<unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SelectorError(`Invalid CSS selector "${selector}": ${message}`)
  }

  if (matches.length === 0) {
    return `No elements matched selector: ${selector}`
  }

  const blocks: string[] = []
  matches.each((index, element) => {
    const text = $(element as Parameters<cheerio.CheerioAPI>[0])
      .text()
      .replace(/\s+/g, ' ')
      .trim()
    blocks.push(`[${index + 1}] ${text}`)
  })

  return `Matched ${matches.length} element(s) for "${selector}":\n${blocks.join('\n')}`
}
