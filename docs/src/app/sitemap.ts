import type { MetadataRoute } from 'next'

import { SITE_URL } from '@/lib/seo'
import { source } from '@/lib/source'

export default function sitemap(): MetadataRoute.Sitemap {
  const home: MetadataRoute.Sitemap[number] = {
    url: SITE_URL,
    changeFrequency: 'weekly',
    priority: 1,
  }

  const docs = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: page.url === '/docs' ? 0.9 : 0.7,
  }))

  return [home, ...docs]
}
