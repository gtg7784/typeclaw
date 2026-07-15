import { constants } from 'node:fs'
import { type FileHandle, open, realpath } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { defineTool, type Tool, type ToolContext } from '@/plugin'

export type WriteReportArgs = { path: string; content: string }

const REPORT_BASENAME_RE = /^research-[a-z0-9][a-z0-9-]*\.md$/
const PROC_FD_PARENT_RE = /^\/proc\/self\/fd\/\d+$/

// One report per session. The researcher subagent object — and therefore this
// tool instance — is built ONCE by `createResearcherSubagent()` at plugin
// registration (src/bundled-plugins/researcher/index.ts) and reused for every
// spawn (run/index.ts reuses `entry.pluginSubagent.customTools`). A plain
// closure boolean would leak across concurrent and sequential sessions, so the
// "already wrote" state is keyed by the per-spawn `ctx.sessionId` instead.
const writtenBySession = new Map<string, true>()

// A dedicated, enforced report writer for the researcher subagent. The generic
// `write` tool is NOT given to the researcher: its runtime boundary (the
// `non-workspace-write` guard) also allowlists IDENTITY.md / SOUL.md / cron.json
// / typeclaw.json / mounts/ / packages/ and honors `acknowledgeGuards`, so a
// guest-spawnable subagent holding generic `write` could write far more than one
// report. This tool moves the boundary INTO a narrow primitive so the contract
// is enforced in code, not prompt obedience:
//   - path must resolve to exactly `<agentDir>/{workspace,public}/research-<slug>.md`
//     (no nested dirs, no other basenames, no other directories),
//   - the parent dir's realpath must equal the real workspace/public dir, which
//     blocks `workspace -> /agent/.env` style symlink escapes that a lexical
//     check would follow,
//   - the file is created with O_EXCL, so an existing file or a planted
//     final-path symlink is rejected rather than clobbered or followed,
//   - a second write in the same session is rejected (one report per spawn),
//   - the schema is strict, so an `acknowledgeGuards` field is rejected, not
//     silently stripped.
export function createWriteReportTool(): Tool<WriteReportArgs> {
  return defineTool<WriteReportArgs>({
    description: `Write your single research report as a markdown file. This is your ONLY way to write a file — there is no general write tool. Call it exactly once.

Constraints (enforced; a violation returns an error):
- \`path\` must be an absolute path of the form \`<agent>/workspace/research-<slug>.md\` or \`<agent>/public/research-<slug>.md\` — directly under workspace/ or public/, no subdirectories, basename \`research-<slug>.md\` where <slug> is lowercase letters, digits and hyphens.
- The file must not already exist (pick a unique slug, e.g. with a timestamp).
- You may write the report only once per session.

Write to \`public/\` instead of \`workspace/\` when your resolved role lacks \`fs.see.private\` (a guest caller cannot read \`workspace/\`); otherwise use \`workspace/\`.`,
    parameters: z.strictObject({
      path: z
        .string()
        .describe('Absolute path: <agent>/workspace/research-<slug>.md or <agent>/public/research-<slug>.md'),
      content: z.string().describe('The full markdown report body.'),
    }),
    fileOperands: { output: ['path'] },
    async execute(args: WriteReportArgs, ctx: ToolContext) {
      if (writtenBySession.has(ctx.sessionId)) {
        throw new Error('A report has already been written for this session. You may write exactly one report.')
      }

      const target = path.resolve(args.path)
      const agentDir = path.resolve(ctx.agentDir)
      const workspaceDir = path.join(agentDir, 'workspace')
      const publicDir = path.join(agentDir, 'public')

      const parent = path.dirname(target)
      const base = path.basename(target)
      const lexicalParent = PROC_FD_PARENT_RE.test(parent) ? await realpath(parent) : parent

      if (!REPORT_BASENAME_RE.test(base)) {
        throw new Error(
          `Report filename must match research-<slug>.md (lowercase slug), got: ${base}. Path: ${target}.`,
        )
      }
      if (lexicalParent !== workspaceDir && lexicalParent !== publicDir) {
        throw new Error(
          `Report must be written directly under ${workspaceDir} or ${publicDir} (no subdirectories), got parent: ${lexicalParent}.`,
        )
      }

      // Resolve ONLY the canonical dir `parent` lexically matched above. `public/`
      // is optional (created only for guest-readable output), so an unconditional
      // `realpath('<agent>/public')` throws ENOENT on agents that never made it,
      // which would reject every valid write to `workspace/`. The symlink-escape
      // defense is unchanged — the parent actually written to is still canonicalized.
      const canonicalDir = lexicalParent === workspaceDir ? workspaceDir : publicDir
      const [realParent, realCanonical] = await Promise.all([realpath(parent), realpath(canonicalDir)])
      if (realParent !== realCanonical) {
        throw new Error(`Report parent directory resolves outside the allowed report directories: ${parent}.`)
      }

      let handle: FileHandle | undefined
      try {
        handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644)
        await handle.writeFile(args.content, 'utf8')
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          throw new Error(`Report file already exists: ${target}. Choose a unique slug (e.g. add a timestamp).`)
        }
        throw err
      } finally {
        await handle?.close()
      }

      writtenBySession.set(ctx.sessionId, true)
      return {
        content: [{ type: 'text' as const, text: `Wrote research report: ${target} (${args.content.length} bytes).` }],
        details: { path: target, bytes: args.content.length },
      }
    },
  })
}
