import * as cheerio from 'cheerio'
import type { AnyNode, Element } from 'domhandler'

const SEMANTIC_TAGS = new Set([
  'header',
  'nav',
  'main',
  'aside',
  'footer',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'label',
  'a',
  'img',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
])

const ROLE_FOR_TAG: Record<string, string> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  a: 'link',
  button: 'button',
  input: 'input',
  select: 'select',
  textarea: 'textarea',
  img: 'image',
  form: 'form',
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  main: 'main',
  aside: 'complementary',
  section: 'section',
  article: 'article',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  th: 'columnheader',
  td: 'cell',
  label: 'label',
}

export function applySnapshot(html: string): string {
  const $ = cheerio.load(html)
  const lines: string[] = []
  const body = $('body').get(0)
  const roots: AnyNode[] = body ? [body] : ($.root().get(0)?.children ?? [])
  for (const root of roots) {
    walk($, root, 0, lines)
  }
  return lines.length > 0 ? lines.join('\n') : 'Page contains no semantic structure.'
}

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag'
}

function walk($: cheerio.CheerioAPI, node: AnyNode, depth: number, out: string[]): void {
  if (!isElement(node)) return

  const tag = node.name.toLowerCase()
  let nextDepth = depth

  if (SEMANTIC_TAGS.has(tag)) {
    const role = ROLE_FOR_TAG[tag] ?? tag
    const label = labelFor($, node)
    const indent = '  '.repeat(depth)
    out.push(label ? `${indent}- ${role}: ${label}` : `${indent}- ${role}`)
    nextDepth = depth + 1
  }

  for (const child of node.children) {
    walk($, child, nextDepth, out)
  }
}

function labelFor($: cheerio.CheerioAPI, element: Element): string {
  const $el = $(element)
  const tag = element.name.toLowerCase()

  if (tag === 'a') {
    const text = $el.text().replace(/\s+/g, ' ').trim()
    const href = $el.attr('href') ?? ''
    return text && href ? `"${truncate(text, 80)}" → ${href}` : text || href
  }
  if (tag === 'img') {
    const alt = $el.attr('alt') ?? ''
    const src = $el.attr('src') ?? ''
    return alt ? `"${truncate(alt, 80)}" (${src})` : src
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const name = $el.attr('name') ?? ''
    const type = $el.attr('type') ?? tag
    const placeholder = $el.attr('placeholder') ?? ''
    const parts = [
      type ? `type=${type}` : '',
      name ? `name=${name}` : '',
      placeholder ? `placeholder="${truncate(placeholder, 40)}"` : '',
    ]
    return parts.filter(Boolean).join(' ')
  }
  if (tag === 'button' || tag === 'label' || /^h[1-6]$/.test(tag) || tag === 'th' || tag === 'td') {
    return truncate($el.text().replace(/\s+/g, ' ').trim(), 120)
  }
  return ''
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
