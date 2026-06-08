import path from 'node:path'

import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
    resolveAlias: {
      'fumadocs-mdx:collections/server': './.source/server.ts',
    },
  },
  async rewrites() {
    return [
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path*.md', destination: '/llms.mdx/docs/:path*' },
    ]
  },
}

const withMDX = createMDX()

export default withMDX(nextConfig)
