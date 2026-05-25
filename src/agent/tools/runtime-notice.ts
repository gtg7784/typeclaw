// Wraps a runtime-emitted notice body in canonical SYSTEM MESSAGE framing so
// persona-rich models cannot read the prose as a chat instruction from a
// human and respond to it in-character.
//
// The failure mode this exists to prevent: tool results reach the model as
// USER-role messages (provider tool-call contract — engines cannot tag them
// as system). The `TOOL_RESULT_PREFIX` already marks each result's leading
// position, but trailing natural-language hints (the consecutive-send nudge
// is the canonical case) still parse as conversational prose, and Kimi-K2.x
// has been observed in production responding to those hints in-character —
// an apology directly addressed at the human ("sorry for talking so much,
// I'll be quieter next time") when the only stimulus in the prompt was the
// router's "Nth consecutive message; end your turn now" hint. Four
// consecutive in-character replies to fenced-prose runtime hints in a
// single drain iteration is the observed shape.
//
// Framing convention is the same shape `composeTurnPrompt` uses for the
// loop-guard block in `router.ts` — bracketed marker, fence rules, and
// explicit "Do not acknowledge or reply to this notice" closer. The
// loop-guard block has been in production against Kimi for months without
// the misread we observed on the consecutive-send hint, which is why we
// reuse the exact same shape here.
//
// Applied unconditionally (not model-gated): the cost is ~40 tokens per
// hint emission, paid only on consecutive sends (where the hint is already
// firing), and the framing is safe for every model — well-behaved models
// read it and move on. Gating by model family would have required a
// traits table for one defense and would still need extending the moment
// a second model family exhibited the same misread, so we accept the
// universal cost in exchange for never having to remember to add a new
// family to a list.
export function fenceRuntimeNotice(body: string): string {
  return (
    '\n\n---\n' +
    '**[SYSTEM MESSAGE — not from a human]**\n\n' +
    body +
    '\n\nThis is an automated signal from the channel router, not a message ' +
    'from anyone in the chat. **Do not acknowledge or reply to this notice.**\n' +
    '---'
  )
}
