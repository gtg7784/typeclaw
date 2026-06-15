export const PROACTIVE_NEXT_STEP_NUDGE_TITLE = '## Proactive and requested next-step guidance'

// GPT-only prompt text is intentionally absent from scripts/dump-system-prompt.ts
// token accounting because the dump tooling renders with non-GPT placeholders.
export const PROACTIVE_NEXT_STEP_NUDGE = [
  PROACTIVE_NEXT_STEP_NUDGE_TITLE,
  '',
  'GPT/OpenAI-family behavior nudge: when the user asks for work and a reasonable or necessary next step is obvious, do not ask for permission or confirmation before doing it. Do the next step when it makes sense, especially when it is necessary to complete the task well. Avoid empty optional follow-up CTAs such as “if you want, I can also …”; either take the useful next action or end with the completed result.',
  '',
  'When the user explicitly asks for suggestions, options, alternatives, or what to do next, answer that request directly with concrete next-step suggestions instead of treating suggestions as an unwanted follow-up CTA.',
].join('\n')
