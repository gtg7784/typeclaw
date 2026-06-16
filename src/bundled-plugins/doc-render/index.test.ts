import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import docRenderPlugin, { RENDER_SCRIPT_AGENT_RELATIVE_PATH, renderScriptPath } from './index'

describe('doc-render plugin', () => {
  test('contributes the skill directory and no tools or hooks', async () => {
    const exports = await bootPlugin()

    expect((exports.skillsDirs ?? []).map((dir) => dir.split(sep).join('/'))).toEqual([
      expect.stringContaining('bundled-plugins/doc-render/skills'),
    ])
    expect(exports.tools).toBeUndefined()
    expect(exports.hooks).toBeUndefined()
  })

  test('the bundled render script exists on disk', () => {
    expect(existsSync(renderScriptPath())).toBe(true)
  })

  test('the agent-relative render path points at the bundled script', () => {
    // The container runs from node_modules/typeclaw/src/...; the agent-relative
    // path the skill uses must end at the same file this package ships.
    expect(RENDER_SCRIPT_AGENT_RELATIVE_PATH).toBe('node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts')
    expect(renderScriptPath()).toMatch(/[\\/]bundled-plugins[\\/]doc-render[\\/]render\.ts$/)
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

  test('renders via the agent-readable render path, not the per-session /tmp hint', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw).toContain(`bun run /agent/${RENDER_SCRIPT_AGENT_RELATIVE_PATH}`)
    expect(raw).not.toContain('/tmp/typeclaw-doc-render-script')
  })

  test('changes into the document directory before rendering so read(...) resolves', async () => {
    const raw = await readFile(skillPath, 'utf8')

    const renderIdx = raw.indexOf('bun run /agent/node_modules/typeclaw')
    const cdIdx = raw.lastIndexOf('\ncd ', renderIdx)
    expect(cdIdx).toBeGreaterThan(0)
    expect(cdIdx).toBeLessThan(renderIdx)
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
