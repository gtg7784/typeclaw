export const PROACTIVE_NEXT_STEP_NUDGE_TITLE = '## Proactive next-step guidance'

export const PROACTIVE_NEXT_STEP_NUDGE = [
  PROACTIVE_NEXT_STEP_NUDGE_TITLE,
  '',
  'GPT/OpenAI-family behavior nudge: when the user asks for work and a reasonable or necessary next step is obvious, do not ask for permission or confirmation before doing it. Do the next step when it makes sense, especially when it is necessary to complete the task well. Avoid empty optional follow-up CTAs such as “if you want, I can also …”; either take the useful next action or end with the completed result.',
].join('\n')
