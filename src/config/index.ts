import type { Model } from '@mariozechner/pi-ai'

// FIXME: TEMP
export const config = {
  // T9 keypad: T=8, Y=9, P=7, E=3
  port: 8973,

  model: {
    id: 'accounts/fireworks/routers/kimi-k2p5-turbo',
    name: 'Kimi K2.5 Turbo',
    api: 'openai-completions',
    provider: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 256000,
  } satisfies Model<'openai-completions'>,
}
