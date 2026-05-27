import { Type } from '@mariozechner/pi-ai'
import type { ImageContent } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { createSessionWithDispose, type SessionOrigin } from '@/agent'

import { buildMultimodalLookerSystemPrompt, resolveImage, type ImageInput } from './looker'

type ImageParam = { url: string } | { path: string } | { data: string; mimeType: string }

type LookAtArgs = {
  images: ImageParam[]
  prompt?: string
}

type LookAtDetails = {
  count: number
  prompt?: string
  text?: string
  error?: string
}

// Routes an image-bearing turn to a vision-capable subagent so the main
// session never sees the bytes. Saves main-agent context: when `models.default`
// is text-only, this is the only way to get vision; when `models.default` IS
// vision-capable, it still buys cheaper main-agent inference because the
// image payload (which can be many KB after base64) only enters the vision
// model's context.
//
// Output is the subagent's text response. The subagent itself decides whether
// to answer the user's question (when `prompt` is supplied) or describe the
// image (when `prompt` is omitted) via its dynamic system prompt.
export const lookAtTool = defineTool({
  name: 'look_at',
  label: 'Look at images',
  description:
    'Route image(s) through a vision-capable subagent and get a text result. ' +
    'Use this when you need to see an image: a screenshot the user shared, a diagram in a doc, a photo, a chart, etc. ' +
    'Each image is specified by ONE of `url` (https://...), `path` (absolute filesystem path), or `data`+`mimeType` (base64). ' +
    'The optional `prompt` is a question to ask about the image(s); without it, the subagent returns a faithful description. ' +
    'The image bytes never enter your context — only the resulting text comes back.',
  parameters: Type.Object({
    images: Type.Array(
      Type.Object({
        url: Type.Optional(Type.String({ description: 'https:// URL to fetch the image from.' })),
        path: Type.Optional(Type.String({ description: 'Absolute filesystem path (inside /agent or a mounted dir).' })),
        data: Type.Optional(Type.String({ description: 'Base64-encoded image bytes (pair with mimeType).' })),
        mimeType: Type.Optional(Type.String({ description: 'MIME type when using `data` (e.g. "image/png").' })),
      }),
      { minItems: 1, description: 'One or more images to look at.' },
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          'Optional question to ask about the image(s). When omitted, the subagent returns a faithful description.',
      }),
    ),
  }),

  async execute(_toolCallId, params, signal) {
    const args = params as LookAtArgs
    try {
      const imageInputs = args.images.map(toImageInput)
      const resolved = await Promise.all(imageInputs.map((i) => resolveImage(i, signal)))
      const imageContents: ImageContent[] = resolved.map((r) => ({
        type: 'image' as const,
        data: r.data,
        mimeType: r.mimeType,
      }))

      const systemPrompt = buildMultimodalLookerSystemPrompt(args.prompt)
      const userText =
        args.prompt !== undefined && args.prompt.trim() !== ''
          ? args.prompt.trim()
          : 'Please describe the attached image(s).'

      const origin: SessionOrigin = {
        kind: 'subagent',
        subagent: 'multimodal-looker',
        parentSessionId: '<look-at-tool>',
      }

      // TODO(usage-accounting): this falls through to SessionManager.inMemory()
      // because no sessionManager is passed, so the look_at subagent's
      // message.usage never reaches the sessions/ JSONLs that `typeclaw usage`
      // and the bundled `backup` plugin scan. Same root-cause class as the
      // plugin-command/cron-handler path fixed in `runPromptForCommand`
      // (src/server/command-runner.ts). Fixing this requires threading a
      // SessionFactory into pi-coding-agent's tool execute() signature, which
      // is a separate change.
      const { session, dispose } = await createSessionWithDispose({
        systemPromptOverride: systemPrompt,
        origin,
        profile: 'vision',
        // Both knobs are required to fully disarm the subagent's tool surface:
        // `customTools: []` blocks typeclaw's system tools (websearch/webfetch/
        // look_at/restart/...) — without it, the look_at tool would recurse
        // into itself. `tools: []` blocks pi-coding-agent's defaults
        // (read/bash/edit/write) — without it, a vision model could be talked
        // into running shell commands or editing files inside its short-lived
        // session. The looker should only describe images, not act.
        tools: [],
        customTools: [],
      })

      try {
        await session.prompt(userText, { images: imageContents })
        const text = extractLastAssistantText(session.messages)
        if (text === null) {
          return errorResult('multimodal-looker returned no text response', {
            count: resolved.length,
            prompt: args.prompt,
          })
        }
        return successResult(text, { count: resolved.length, prompt: args.prompt })
      } finally {
        session.dispose()
        await dispose()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(message, { count: args.images.length, prompt: args.prompt })
    }
  },
})

function toImageInput(p: ImageParam): ImageInput {
  const hasUrl = 'url' in p && p.url !== undefined && p.url !== ''
  const hasPath = 'path' in p && p.path !== undefined && p.path !== ''
  const hasData = 'data' in p && p.data !== undefined && p.data !== ''
  const hasMime = 'mimeType' in p && p.mimeType !== undefined && p.mimeType !== ''

  // `data` and `mimeType` are paired — accept both as one source. `mimeType`
  // alone with no `data` is rejected as an incomplete base64 spec.
  const sources: string[] = []
  if (hasUrl) sources.push('url')
  if (hasPath) sources.push('path')
  if (hasData || hasMime) sources.push('data+mimeType')

  if (sources.length === 0) {
    throw new Error('look_at: each image must specify exactly one of `url`, `path`, or `data`+`mimeType`')
  }
  if (sources.length > 1) {
    throw new Error(
      `look_at: each image must specify exactly one of \`url\`, \`path\`, or \`data\`+\`mimeType\` (got: ${sources.join(', ')})`,
    )
  }
  if (hasUrl) return { kind: 'url', url: (p as { url: string }).url }
  if (hasPath) return { kind: 'file', path: (p as { path: string }).path }
  if (hasData && hasMime) {
    return { kind: 'base64', data: (p as { data: string }).data, mimeType: (p as { mimeType: string }).mimeType }
  }
  throw new Error('look_at: base64 image requires both `data` and `mimeType`')
}

// Pulls the most recent assistant turn's text content. The subagent's reply
// shows up here once `session.prompt()` resolves. Tool calls in the assistant
// message are ignored — multimodal-looker's session has no tools wired in
// (`tools: []` + `customTools: []` at session creation), so in practice this
// is pure text plus optional thinking blocks (which we skip).
function extractLastAssistantText(messages: ReadonlyArray<unknown>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (msg === undefined || msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const texts: string[] = []
    for (const part of content) {
      if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const t = (part as { text?: unknown }).text
        if (typeof t === 'string') texts.push(t)
      }
    }
    if (texts.length > 0) return texts.join('\n').trim()
  }
  return null
}

function successResult(text: string, partial: Omit<LookAtDetails, 'text' | 'error'>) {
  const details: LookAtDetails = { ...partial, text }
  return {
    content: [{ type: 'text' as const, text }],
    details,
  }
}

function errorResult(message: string, partial: Omit<LookAtDetails, 'text' | 'error'>) {
  const details: LookAtDetails = { ...partial, error: message }
  return {
    content: [{ type: 'text' as const, text: `look_at failed: ${message}` }],
    details,
  }
}
