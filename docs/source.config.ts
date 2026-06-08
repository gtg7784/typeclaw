import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { defineDocs, defineConfig } from 'fumadocs-mdx/config'

export const { docs, meta } = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      // Required for `page.data.getText('processed')`, used by the llms.txt routes.
      includeProcessedMarkdown: true,
    },
  },
})

export default defineConfig({
  mdxOptions: {
    providerImportSource: '@/mdx-components',
    remarkPlugins: [remarkMdxMermaid],
  },
})
