import path from 'node:path'

import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
}

const withMDX = createMDX()

export default withMDX(nextConfig)
