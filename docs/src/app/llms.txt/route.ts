import { llms } from 'fumadocs-core/source'

import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/seo'
import { source } from '@/lib/source'

export const revalidate = false

export function GET(): Response {
  // Fumadocs prefixes the index with a bare `# <root>` heading (the page tree has no
  // root title, so it renders empty). Replace it with a branded title + summary so the
  // llms.txt opens with what TypeClaw is, per the llmstxt.org convention.
  const pageList = llms(source)
    .index()
    .replace(/^#[^\n]*\n+/, '')
  const body = `# ${SITE_NAME}\n\n> ${SITE_DESCRIPTION}\n\n${pageList}`

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
