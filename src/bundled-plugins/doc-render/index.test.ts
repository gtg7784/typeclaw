import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import docRenderPlugin, { RENDER_SCRIPT_HINT_PATH, renderScriptPath } from './index'

describe('doc-render plugin', () => {
  test('contributes the skill directory and no tools or hooks', async () => {
    const exports = await bootPlugin()

    expect(exports.skillsDirs).toEqual([expect.stringContaining('bundled-plugins/doc-render/skills')])
    expect(exports.tools).toBeUndefined()
    expect(exports.hooks).toBeUndefined()
  })

  test('publishes the bundled render script path to the /tmp hint', async () => {
    await bootPlugin()

    expect(existsSync(RENDER_SCRIPT_HINT_PATH)).toBe(true)
    expect(await readFile(RENDER_SCRIPT_HINT_PATH, 'utf8')).toBe(renderScriptPath())
  })

  test('the hinted render script actually exists on disk', () => {
    expect(existsSync(renderScriptPath())).toBe(true)
  })
})

describe('typeclaw-render-pdf skill', () => {
  const skillPath = join(import.meta.dir, 'skills', 'typeclaw-render-pdf', 'SKILL.md')

  test('ships with YAML frontmatter naming the skill', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw.startsWith('---\n')).toBe(true)
    const frontmatterEnd = raw.indexOf('\n---\n', 4)
    expect(frontmatterEnd).toBeGreaterThan(0)
    const frontmatter = raw.slice(4, frontmatterEnd)
    expect(frontmatter).toMatch(/^name:\s*typeclaw-render-pdf\s*$/m)
    expect(frontmatter).toMatch(/^description:\s*\S/m)
  })

  test('forbids ad-hoc PDF libraries', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw).toMatch(/only supported way to make a PDF from Markdown/i)
    expect(raw).toMatch(/jsPDF/)
    expect(raw).toMatch(/pdfkit/)
    expect(raw).toMatch(/ReportLab/)
  })

  test('handles CJK by detecting tofu after render, never auto-downloading a font', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw).toContain('## Handling CJK content')
    expect(raw).toMatch(/CJK fonts are \*\*opt-in\*\*/)
    expect(raw).toMatch(/docker\.file\.cjkFonts/)
    expect(raw).toMatch(/typeclaw restart/)
    expect(raw).not.toContain('NotoSerifKR-Regular.otf')
    expect(raw).not.toContain('workspace/.tools/fonts')
  })

  test('installs the compiler into the agent root, not a workspace .tools dir', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw).toContain('bun add @myriaddreamin/typst-ts-node-compiler@0.7.0')
    expect(raw).not.toContain('workspace/.tools')
  })
})

async function bootPlugin() {
  return docRenderPlugin.plugin(
    createPluginContext({
      name: 'doc-render',
      version: undefined,
      agentDir: '/agent',
      config: undefined,
      logger: createPluginLogger('doc-render'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    }),
  )
}
