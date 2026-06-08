import type { MetadataRoute } from 'next'

import { source } from '@/lib/source'

const BASE_URL = 'https://typeclaw.dev'

export default function sitemap(): MetadataRoute.Sitemap {
  const home: MetadataRoute.Sitemap[number] = {
    url: BASE_URL,
    changeFrequency: 'weekly',
    priority: 1,
  }

  const docs = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: page.url === '/docs' ? 0.9 : 0.7,
  }))

  return [home, ...docs]
}
