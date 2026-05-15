import { describe, expect, test } from 'bun:test'

import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'
import type { LLMAuth } from '@/init'
import type { ModelOption } from '@/init/models-dev'

import { collectWizardInputs, decideExistingApiKeyReuse, type WizardPrompts } from './init'

describe('decideExistingApiKeyReuse', () => {
  test('reuses an existing API key when the user confirms', async () => {
    const messages: string[] = []

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.openai, 'openai-existing-key', async (message) => {
      messages.push(message)
      return true
    })

    expect(decision).toBe('reuse')
    expect(messages).toEqual(['Reuse existing OpenAI API key from secrets.json?'])
  })

  test('prompts for a new API key when the user declines reuse', async () => {
    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.fireworks, 'fw_existing', async () => false)

    expect(decision).toBe('prompt')
  })

  test('skips the reuse question when there is no existing API key', async () => {
    let asked = false

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS.openai, null, async () => {
      asked = true
      return true
    })

    expect(decision).toBe('prompt')
    expect(asked).toBe(false)
  })

  test('skips the reuse question for OAuth-only providers', async () => {
    let asked = false

    const decision = await decideExistingApiKeyReuse(KNOWN_PROVIDERS['openai-codex'], 'unused-key', async () => {
      asked = true
      return true
    })

    expect(decision).toBe('prompt')
    expect(asked).toBe(false)
  })
})

describe('collectWizardInputs back-aware flow', () => {
  const fireworksModel: ModelOption = {
    providerId: 'fireworks',
    providerName: 'Fireworks',
    modelId: 'accounts/fireworks/routers/kimi-k2p6-turbo',
    modelName: 'Kimi K2.6 Turbo',
    ref: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    contextWindow: 256000,
    reasoning: true,
    curated: true,
  }
  const openaiModel: ModelOption = {
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5.4-nano',
    modelName: 'GPT-5.4 Nano',
    ref: 'openai/gpt-5.4-nano',
    contextWindow: 128000,
    reasoning: false,
    curated: true,
  }
  const codexModel: ModelOption = {
    providerId: 'openai-codex',
    providerName: 'OpenAI Codex',
    modelId: 'gpt-5.4-mini',
    modelName: 'GPT-5.4 Mini',
    ref: 'openai-codex/gpt-5.4-mini',
    contextWindow: 128000,
    reasoning: true,
    curated: true,
  }

  function makeRecorder(): { steps: string[]; record: (name: string) => void } {
    const steps: string[] = []
    return { steps, record: (name) => steps.push(name) }
  }

  function makePrompts(overrides: Partial<WizardPrompts> = {}): WizardPrompts {
    return {
      loadCatalog: async () => ({ options: [fireworksModel, openaiModel, codexModel], source: 'curated' }),
      readExistingApiKey: async () => null,
      pickProvider: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel }),
      askReuseExistingKey: async () => ({ kind: 'value', value: 'prompt' }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => ({ kind: 'value', value: 'sk_test' }),
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
      runChannelFlow: async () => ({ kind: 'value', value: {} }),
      buildOAuthAuth: () => ({ kind: 'oauth', runLogin: async () => ({ ok: true }) }) as LLMAuth,
      ...overrides,
    }
  }

  test('happy path: walks every step in order and returns inputs', async () => {
    const { steps, record } = makeRecorder()
    const prompts = makePrompts({
      loadCatalog: async () => {
        record('load-catalog')
        return { options: [fireworksModel], source: 'curated' }
      },
      pickProvider: async () => {
        record('pick-provider')
        return { kind: 'value', value: 'fireworks' as KnownProviderId }
      },
      pickModel: async () => {
        record('pick-model')
        return { kind: 'value', value: fireworksModel }
      },
      askReuseExistingKey: async () => {
        record('reuse-existing-key')
        return { kind: 'value', value: 'prompt' }
      },
      pickAuthMethod: async () => {
        record('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        record('enter-api-key')
        return { kind: 'value', value: 'fw_test' }
      },
      pickChannel: async () => {
        record('pick-channel')
        return { kind: 'value', value: 'none' }
      },
      runChannelFlow: async () => {
        record('channel-flow')
        return { kind: 'value', value: {} }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(steps).toEqual([
      'load-catalog',
      'pick-provider',
      'pick-model',
      'reuse-existing-key',
      'pick-auth-method',
      'enter-api-key',
      'pick-channel',
      'channel-flow',
    ])
    expect(result).not.toBeNull()
    expect(result!.model).toBe(fireworksModel)
    expect(result!.llmAuth).toEqual({ kind: 'api-key', apiKey: 'fw_test' })
    expect(result!.channelSecrets).toEqual({})
  })

  test('back from pick-provider aborts (returns null)', async () => {
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'back' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(result).toBeNull()
  })

  test('back from pick-model returns to pick-provider, then advances', async () => {
    const calls: string[] = []
    let modelBacked = false
    const prompts = makePrompts({
      pickProvider: async () => {
        calls.push('pick-provider')
        return { kind: 'value', value: 'fireworks' as KnownProviderId }
      },
      pickModel: async () => {
        calls.push('pick-model')
        if (!modelBacked) {
          modelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: fireworksModel }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-provider', 'pick-model', 'pick-provider', 'pick-model'])
    expect(result).not.toBeNull()
  })

  test('back from pick-channel returns to enter-api-key when api-key was chosen', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'sk_test' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'enter-api-key', 'pick-channel', 'enter-api-key', 'pick-channel'])
  })

  test('back from pick-channel returns to pick-auth-method when oauth was chosen', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'pick-channel', 'pick-auth-method', 'pick-channel'])
  })

  test('back from pick-channel returns to reuse-existing-key when reuse was chosen', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      readExistingApiKey: async () => 'sk_existing',
      askReuseExistingKey: async () => {
        calls.push('reuse-existing-key')
        return { kind: 'value', value: 'reuse' }
      },
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'fw_test' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['reuse-existing-key', 'pick-channel', 'reuse-existing-key', 'pick-channel'])
    expect(calls).not.toContain('pick-auth-method')
    expect(calls).not.toContain('enter-api-key')
  })

  test('changing provider clears the previously picked model so it is re-asked fresh', async () => {
    let providerCallCount = 0
    let reuseBacked = false
    const modelInitials: (string | undefined)[] = []
    const prompts = makePrompts({
      pickProvider: async () => {
        providerCallCount += 1
        return { kind: 'value', value: (providerCallCount === 1 ? 'fireworks' : 'openai') as KnownProviderId }
      },
      pickModel: async (_options, providerId, initial) => {
        modelInitials.push(initial)
        return {
          kind: 'value',
          value: providerId === 'fireworks' ? fireworksModel : openaiModel,
        }
      },
      askReuseExistingKey: async () => {
        if (!reuseBacked) {
          reuseBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'prompt' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(providerCallCount).toBe(1)
    expect(modelInitials.length).toBeGreaterThanOrEqual(2)
    expect(modelInitials[1]).toBe(fireworksModel.ref)
  })

  test('picking a different provider on retry discards the prior model selection', async () => {
    let providerCallCount = 0
    let modelBackedOnce = false
    const modelInitials: (string | undefined)[] = []
    const prompts = makePrompts({
      pickProvider: async () => {
        providerCallCount += 1
        return { kind: 'value', value: (providerCallCount === 1 ? 'fireworks' : 'openai') as KnownProviderId }
      },
      pickModel: async (_options, providerId, initial) => {
        modelInitials.push(initial)
        if (providerId === 'fireworks' && !modelBackedOnce) {
          return { kind: 'value', value: fireworksModel }
        }
        if (providerId === 'fireworks') {
          return { kind: 'back' }
        }
        return { kind: 'value', value: openaiModel }
      },
      askReuseExistingKey: async () => {
        if (!modelBackedOnce) {
          modelBackedOnce = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'prompt' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(providerCallCount).toBe(2)
    expect(modelInitials[modelInitials.length - 1]).toBeUndefined()
  })

  test('catalog is loaded once even when stepping back across providers', async () => {
    let catalogLoads = 0
    let providerCallCount = 0
    const prompts = makePrompts({
      loadCatalog: async () => {
        catalogLoads += 1
        return { options: [fireworksModel], source: 'curated' }
      },
      pickProvider: async () => {
        providerCallCount += 1
        return { kind: 'value', value: 'fireworks' as KnownProviderId }
      },
      pickModel: async () => {
        if (providerCallCount === 1) return { kind: 'back' }
        return { kind: 'value', value: fireworksModel }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(catalogLoads).toBe(1)
    expect(providerCallCount).toBe(2)
  })

  test('back from channel-flow returns to pick-channel', async () => {
    const calls: string[] = []
    let flowBacked = false
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      runChannelFlow: async () => {
        calls.push('channel-flow')
        if (!flowBacked) {
          flowBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: { discordBotToken: 'tok' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'channel-flow', 'pick-channel', 'channel-flow'])
    expect(result!.channelSecrets).toEqual({ discordBotToken: 'tok' })
  })
})
