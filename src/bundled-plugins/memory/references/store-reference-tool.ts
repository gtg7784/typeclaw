import { mkdir, writeFile } from 'node:fs/promises'

import { z } from 'zod'

import { defineTool } from '@/plugin'

import { referenceFilePath, referencesDir } from '../paths'
import { headingToSlug } from '../slug'
import { renderReference } from './frontmatter'
import { listReferenceSlugs } from './load-references'

export const storeReferenceTool = createStoreReferenceTool()

export function createStoreReferenceTool() {
  return defineTool({
    description:
      'store_reference: Store a verbatim reference artifact under memory/references/ and return its slug. Use this for user-provided SQL, code blocks, runbooks, pasted specs, or other content explicitly meant to be remembered byte-for-byte. This tool does not write memory stream fragments.',
    parameters: z.object({
      title: z.string().min(1),
      body: z.string(),
      origin: z.enum(['episode', 'curated', 'external']),
      tags: z.array(z.string()).optional(),
    }),
    async execute({ title, body, origin, tags }, ctx) {
      const existingSlugs = new Set(await listReferenceSlugs(ctx.agentDir))
      const slug = headingToSlug(title, existingSlugs)
      const created = new Date().toISOString()
      const path = referenceFilePath(ctx.agentDir, slug)

      await mkdir(referencesDir(ctx.agentDir), { recursive: true })
      await writeFile(
        path,
        renderReference(
          {
            title,
            origin,
            created,
            lastAccessed: created,
            accessCount: 0,
            pinned: false,
            demoted: false,
            tags: tags ?? [],
          },
          body,
        ),
        'utf8',
      )

      return {
        content: [{ type: 'text' as const, text: `Stored reference as ${slug}` }],
        details: { path, slug },
      }
    },
  })
}
