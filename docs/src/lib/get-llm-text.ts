import type { InferPageType } from 'fumadocs-core/source'

import type { source } from '@/lib/source'

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const processed = (await page.data.getText('processed')).trim()
  const { title, description } = page.data

  const header = [`# ${title}`, `URL: ${page.url}`, description].filter(Boolean).join('\n')

  return `${header}\n\n${processed}`
}
