import { describe, expect, mock, test } from 'bun:test'

import { KNOWN_PROVIDERS, supportsApiKey, supportsOAuth, type KnownProviderId } from '@/config/providers'
import type { ModelOption } from '@/init/models-dev'

import {
  collectWizardInputs,
  decideExistingApiKeyReuse,
  formatModelLabel,
  sortRecommendedFirst,
  WizardAbortedError,
  type WizardPrompts,
} from './init'

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
    supportsVision: true,
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
    supportsVision: true,
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
    supportsVision: true,
  }
  const zaiTextOnlyModel: ModelOption = {
    providerId: 'zai',
    providerName: 'Z.AI',
    modelId: 'glm-4.6',
    modelName: 'GLM-4.6',
    ref: 'zai/glm-4.6',
    contextWindow: 200000,
    reasoning: true,
    curated: true,
    supportsVision: false,
  }
  const anthropicModel: ModelOption = {
    providerId: 'anthropic',
    providerName: 'Anthropic',
    modelId: 'claude-sonnet-4-6',
    modelName: 'Claude Sonnet 4.6',
    ref: 'anthropic/claude-sonnet-4-6',
    contextWindow: 1000000,
    reasoning: true,
    curated: true,
    supportsVision: true,
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
      validateApiKey: async () => ({ kind: 'ok' as const }),
      pickVisionProvider: async () => ({ kind: 'value', value: 'skip' }),
      pickVisionModel: async () => ({ kind: 'value', value: openaiModel }),
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
      hasExistingChannelSecrets: async () => false,
      askReuseExistingChannel: async () => ({ kind: 'value', value: 'prompt' }),
      runChannelFlow: async () => ({ kind: 'value', value: {} }),
      runOAuthLogin: async () => ({ ok: true }),
      askOAuthFailureRecovery: async () => 'abort',
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
    expect(result.model).toBe(fireworksModel)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'fw_test' })
    expect(result.channelSecrets).toEqual({})
  })

  test('back from pick-provider re-asks the same prompt; cancelling twice aborts', async () => {
    let providerCalls = 0
    const prompts = makePrompts({
      pickProvider: async () => {
        providerCalls += 1
        return { kind: 'back' }
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(providerCalls).toBe(2)
  })

  test('back from pick-provider then pick succeeds (single cancel is still a no-op)', async () => {
    let providerCalls = 0
    const prompts = makePrompts({
      pickProvider: async () => {
        providerCalls += 1
        if (providerCalls === 1) return { kind: 'back' }
        return { kind: 'value', value: 'fireworks' as KnownProviderId }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(providerCalls).toBe(2)
    expect(result.model).toBe(fireworksModel)
  })

  test('aborts when back from enter-api-key auto-advances back to enter-api-key (single-method provider)', async () => {
    // given: Fireworks is api-key-only, so pickAuthMethod returns autoValue
    //   without prompting. The real CLI uses this code path; here we
    //   simulate it directly with kind: 'value', auto: true.
    let apiKeyCalls = 0
    const prompts = makePrompts({
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key', auto: true }),
      askApiKey: async () => {
        apiKeyCalls += 1
        return { kind: 'back' }
      },
    })

    // when + then
    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    // The user only ever interacts with the api-key prompt. Two cancels
    // are enough to escape: the second cancel revisits enter-api-key with
    // pendingBackOrigin already set to enter-api-key, so it aborts.
    expect(apiKeyCalls).toBe(2)
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

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-provider', 'pick-model', 'pick-provider', 'pick-model'])
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

  test('text-only default model: vision picker runs after auth, before pick-channel', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionProvider: async (options) => {
        calls.push('pick-vision-provider')
        // Vision picker MUST be fed only vision-capable models.
        expect(options.every((o) => o.supportsVision)).toBe(true)
        expect(options.some((o) => o.ref === zaiTextOnlyModel.ref)).toBe(false)
        return { kind: 'value', value: 'openai' as KnownProviderId }
      },
      pickVisionModel: async () => {
        calls.push('pick-vision-model')
        return { kind: 'value', value: openaiModel }
      },
      pickAuthMethod: async (_provider, _initial) => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method',
      'enter-api-key',
      'pick-vision-provider',
      'pick-vision-model',
      'pick-auth-method',
      'enter-api-key',
      'pick-channel',
    ])
    expect(result!.vision?.model.ref).toBe(openaiModel.ref)
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'zai_key' })
  })

  test('vision-capable default model: vision picker is skipped entirely', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel }),
      pickVisionProvider: async () => {
        calls.push('pick-vision-provider')
        return { kind: 'value', value: 'skip' }
      },
      pickVisionModel: async () => {
        calls.push('pick-vision-model')
        return { kind: 'value', value: openaiModel }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([])
    expect(result!.vision).toBeUndefined()
  })

  test('vision skip returns no vision profile', async () => {
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      pickVisionProvider: async () => ({ kind: 'value', value: 'skip' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(result!.vision).toBeUndefined()
  })

  test('vision provider matches default provider: reuses default credentials, no auth prompt', async () => {
    const calls: string[] = []
    const visionOpenAI: ModelOption = { ...openaiModel, ref: 'openai/gpt-5.4', modelId: 'gpt-5.4' }
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, visionOpenAI], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: { ...zaiTextOnlyModel, supportsVision: true } }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'enter-api-key'])
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'zai_key' })
  })

  test('vision provider with existing key in secrets.json: reuses without re-prompting', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      readExistingApiKey: async (_cwd, providerId) => (providerId === 'openai' ? 'sk_existing_openai' : null),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => ({ kind: 'value', value: 'zai_key' }),
      pickVisionProvider: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method'])
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing_openai' })
  })

  test('back from pick-vision-provider returns to the auth-finalizing step', async () => {
    const calls: string[] = []
    let backed = false
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionProvider: async () => {
        calls.push('pick-vision-provider')
        if (!backed) {
          backed = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'skip' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['enter-api-key', 'pick-vision-provider', 'enter-api-key', 'pick-vision-provider'])
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
    expect(result.channelSecrets).toEqual({ discordBotToken: 'tok' })
  })

  test('existing channel secrets: prompts to reuse and skips channel-flow on accept', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async (_cwd, channel) => channel === 'discord',
      askReuseExistingChannel: async () => {
        calls.push('reuse-existing-channel')
        return { kind: 'value', value: 'reuse' }
      },
      runChannelFlow: async () => {
        calls.push('channel-flow')
        return { kind: 'value', value: { discordBotToken: 'tok' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'reuse-existing-channel'])
    expect(calls).not.toContain('channel-flow')
    expect(result.reuseExistingChannel).toBe(true)
    expect(result.channelChoice).toBe('discord')
    expect(result.channelSecrets).toEqual({})
  })

  test('existing channel secrets: declining reuse falls through to channel-flow', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async () => true,
      askReuseExistingChannel: async () => {
        calls.push('reuse-existing-channel')
        return { kind: 'value', value: 'prompt' }
      },
      runChannelFlow: async () => {
        calls.push('channel-flow')
        return { kind: 'value', value: { discordBotToken: 'new-tok' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'reuse-existing-channel', 'channel-flow'])
    expect(result.reuseExistingChannel).toBe(false)
    expect(result.channelSecrets).toEqual({ discordBotToken: 'new-tok' })
  })

  test('no existing channel secrets: reuse prompt is suppressed entirely', async () => {
    const calls: string[] = []
    const askReuse = mock(async () => ({ kind: 'value' as const, value: 'reuse' as const }))
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async () => false,
      askReuseExistingChannel: askReuse,
      runChannelFlow: async () => {
        calls.push('channel-flow')
        return { kind: 'value', value: { discordBotToken: 'tok' } }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(askReuse).not.toHaveBeenCalled()
    expect(calls).toEqual(['pick-channel', 'channel-flow'])
  })

  test('back from reuse-existing-channel returns to pick-channel', async () => {
    const calls: string[] = []
    let reuseBacked = false
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async () => true,
      askReuseExistingChannel: async () => {
        calls.push('reuse-existing-channel')
        if (!reuseBacked) {
          reuseBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'reuse' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'reuse-existing-channel', 'pick-channel', 'reuse-existing-channel'])
  })

  test('back from channel-flow returns to reuse-existing-channel when reuse was offered', async () => {
    const calls: string[] = []
    let flowBacked = false
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async () => true,
      askReuseExistingChannel: async () => {
        calls.push('reuse-existing-channel')
        return { kind: 'value', value: 'prompt' }
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

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-channel',
      'reuse-existing-channel',
      'channel-flow',
      'reuse-existing-channel',
      'channel-flow',
    ])
  })

  test('changing channel after declining reuse clears the offered state so telegram skips reuse prompt', async () => {
    const calls: string[] = []
    let pickCount = 0
    let reuseBacked = false
    const prompts = makePrompts({
      pickChannel: async () => {
        pickCount += 1
        calls.push(`pick-channel:${pickCount}`)
        return { kind: 'value', value: pickCount === 1 ? 'discord' : 'telegram' }
      },
      hasExistingChannelSecrets: async (_cwd, channel) => channel === 'discord',
      askReuseExistingChannel: async () => {
        calls.push('reuse-existing-channel')
        if (!reuseBacked) {
          reuseBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'prompt' }
      },
      runChannelFlow: async (choice) => {
        calls.push(`channel-flow:${choice}`)
        return { kind: 'value', value: choice === 'telegram' ? { telegramBotToken: 'tg' } : { discordBotToken: 'd' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(result.channelChoice).toBe('telegram')
    expect(result.channelSecrets).toEqual({ telegramBotToken: 'tg' })
    expect(calls).toEqual(['pick-channel:1', 'reuse-existing-channel', 'pick-channel:2', 'channel-flow:telegram'])
  })

  test('github: wizard collects structured credentials into channelSecrets.github', async () => {
    const calls: string[] = []
    // Production hasExistingChannelSecrets returns false for github so the
    // reuse prompt is suppressed. The test mirrors that contract here.
    const hasExisting = mock(async (_cwd: string, channel: string) => channel !== 'github')
    const askReuse = mock(async () => ({ kind: 'value' as const, value: 'reuse' as const }))
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'github' }
      },
      hasExistingChannelSecrets: hasExisting,
      askReuseExistingChannel: askReuse,
      runChannelFlow: async (choice) => {
        calls.push(`channel-flow:${choice}`)
        return {
          kind: 'value',
          value: {
            github: {
              webhookSecret: 'whsec',
              tunnelProvider: 'external',
              webhookUrl: 'https://example.com/wh',
              webhookPort: 8975,
              repos: ['acme/repo-a', 'acme/repo-b'],
              auth: { type: 'pat', pat: 'ghp_test' },
            },
          },
        }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(hasExisting).toHaveBeenCalledWith('/agent', 'github')
    expect(askReuse).not.toHaveBeenCalled()
    expect(calls).toEqual(['pick-channel', 'channel-flow:github'])
    expect(result.channelChoice).toBe('github')
    expect(result.reuseExistingChannel).toBe(false)
    expect(result.channelSecrets).toEqual({
      github: {
        webhookSecret: 'whsec',
        tunnelProvider: 'external',
        webhookUrl: 'https://example.com/wh',
        webhookPort: 8975,
        repos: ['acme/repo-a', 'acme/repo-b'],
        auth: { type: 'pat', pat: 'ghp_test' },
      },
    })
  })

  test('oauth path: runs login inside the wizard, before pick-channel', async () => {
    const calls: string[] = []
    const loginCalls: Array<{ cwd: string; model: string; providerName: string }> = []
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerName: provider.name })
        calls.push('run-oauth-login')
        return { ok: true }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([
      { cwd: '/agent', model: codexModel.ref, providerName: KNOWN_PROVIDERS['openai-codex'].name },
    ])
    expect(calls).toEqual(['pick-auth-method', 'run-oauth-login', 'pick-channel'])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('oauth path: login failure prompts recovery; user picks retry and succeeds', async () => {
    const calls: string[] = []
    let loginAttempt = 0
    let authMethodCalls = 0
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        authMethodCalls += 1
        calls.push(`pick-auth-method:${authMethodCalls}`)
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        loginAttempt += 1
        calls.push(`run-oauth-login:${loginAttempt}`)
        if (loginAttempt === 1) return { ok: false, reason: 'browser closed' }
        return { ok: true }
      },
      askOAuthFailureRecovery: async (provider, reason) => {
        calls.push(`recovery:${provider.id}:${reason}`)
        return 'retry'
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method:1',
      'run-oauth-login:1',
      'recovery:openai-codex:browser closed',
      'pick-auth-method:2',
      'run-oauth-login:2',
      'pick-channel',
    ])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('oauth path: login failure → user picks api-key fallback routes to enter-api-key', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        calls.push('run-oauth-login')
        return { ok: false, reason: 'token revoked' }
      },
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        calls.push(`recovery:apiKeyAvailable=${apiKeyAvailable}`)
        return 'api-key'
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'sk_fallback' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method',
      'run-oauth-login',
      'recovery:apiKeyAvailable=true',
      'enter-api-key',
      'pick-channel',
    ])
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_fallback' })
  })

  test('oauth path: login failure → user picks abort throws WizardAbortedError', async () => {
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'cancelled' }),
      askOAuthFailureRecovery: async () => 'abort',
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
  })

  test('oauth path: oauth-only provider gets apiKeyAvailable=false in recovery prompt', async () => {
    let apiKeyAvailableSeen: boolean | undefined
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'whatever' }),
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        apiKeyAvailableSeen = apiKeyAvailable
        return 'abort'
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(apiKeyAvailableSeen).toBe(false)
  })

  test('oauth path: runner that throws is coerced to a failure recovery prompt (init never crashes)', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        calls.push('run-oauth-login')
        throw new Error('unexpected runner crash')
      },
      askOAuthFailureRecovery: async (_provider, reason) => {
        calls.push(`recovery:${reason}`)
        return 'abort'
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(calls).toEqual(['pick-auth-method', 'run-oauth-login', 'recovery:unexpected runner crash'])
  })

  test('oauth path: vision profile also runs login inside the wizard when provider differs', async () => {
    const calls: string[] = []
    const loginCalls: Array<{ cwd: string; model: string; providerName: string }> = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, codexModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'zai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => ({ kind: 'value', value: 'zai_key' }),
      pickVisionProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async (provider) => {
        calls.push(`pick-auth-method:${provider.id}`)
        return { kind: 'value', value: provider.id === 'openai-codex' ? 'oauth' : 'api-key' }
      },
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerName: provider.name })
        calls.push('run-oauth-login')
        return { ok: true }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([
      { cwd: '/agent', model: codexModel.ref, providerName: KNOWN_PROVIDERS['openai-codex'].name },
    ])
    expect(result.vision?.llmAuth).toEqual({ kind: 'oauth-completed' })
    // OAuth login runs immediately after the vision provider's auth method is
    // picked — before pick-channel. The default provider (Z.AI, api-key only)
    // never reaches runOAuthLogin.
    expect(calls).toEqual(['pick-auth-method:zai', 'pick-auth-method:openai-codex', 'run-oauth-login', 'pick-channel'])
  })

  test('oauth path: stale pendingBackOrigin from a pre-OAuth back is cleared by recovery prompt', async () => {
    // Regression for the bug surfaced by self-review: a back press from
    // enter-api-key (which sets pendingBackOrigin = 'enter-api-key') followed
    // by an autoValue OAuth attempt + OAuth failure + recovery=api-key would
    // route back to enter-api-key. The user's first back press there would
    // see the stale pendingBackOrigin and spuriously abort the wizard.
    let askApiKeyCalls = 0
    let askApiKeyBackCount = 0
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'failed' }),
      askOAuthFailureRecovery: async () => 'api-key',
      askApiKey: async () => {
        askApiKeyCalls += 1
        if (askApiKeyCalls === 1) {
          askApiKeyBackCount += 1
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'sk_recovered' }
      },
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    // The single back press at enter-api-key must NOT abort — pendingBackOrigin
    // was reset by the recovery prompt, so this is treated as a first-back.
    expect(askApiKeyBackCount).toBe(1)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_recovered' })
  })

  test('oauth path: WizardAbortedError carries oauthCredentialsSaved=true after a successful OAuth', async () => {
    // Successful OAuth, then user aborts later (double-back from pick-channel).
    // The wizard must surface that credentials were already written so the CLI
    // can warn the user instead of exiting silently.
    let channelBacks = 0
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth', auto: true }),
      runOAuthLogin: async () => ({ ok: true }),
      pickChannel: async () => {
        channelBacks += 1
        return { kind: 'back' }
      },
    })

    try {
      await collectWizardInputs('/agent', prompts)
      throw new Error('expected WizardAbortedError')
    } catch (error) {
      expect(error).toBeInstanceOf(WizardAbortedError)
      expect((error as WizardAbortedError).oauthCredentialsSaved).toBe(true)
    }
    expect(channelBacks).toBeGreaterThanOrEqual(1)
  })

  test('oauth path: WizardAbortedError.oauthCredentialsSaved is false when OAuth never succeeded', async () => {
    const prompts = makePrompts({
      pickProvider: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'nope' }),
      askOAuthFailureRecovery: async () => 'abort',
    })

    try {
      await collectWizardInputs('/agent', prompts)
      throw new Error('expected WizardAbortedError')
    } catch (error) {
      expect(error).toBeInstanceOf(WizardAbortedError)
      expect((error as WizardAbortedError).oauthCredentialsSaved).toBe(false)
    }
  })

  test('dual-auth provider (anthropic): pickAuthMethod is REAL prompt with both options, not autoValue', async () => {
    // given: anthropic supports both api-key and oauth. Unlike openai
    //   (api-key-only) and openai-codex (oauth-only), pickAuthMethod must
    //   actually ask the user — autoValue is wrong here. We assert the
    //   prompt sees the live provider and that the wizard honors the
    //   user's selection literally.
    let seenProviderId: string | undefined
    let seenBothAuthModes: boolean | undefined
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async (provider) => {
        seenProviderId = provider.id
        seenBothAuthModes = supportsApiKey(provider) && supportsOAuth(provider)
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => ({ kind: 'value', value: 'sk-ant-test' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(seenProviderId).toBe('anthropic')
    expect(seenBothAuthModes).toBe(true)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk-ant-test' })
  })

  test('dual-auth provider (anthropic): user picks oauth → runOAuthLogin fires with anthropic ref', async () => {
    const loginCalls: Array<{ cwd: string; model: string; providerId: string }> = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerId: provider.id })
        return { ok: true }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([{ cwd: '/agent', model: 'anthropic/claude-sonnet-4-6', providerId: 'anthropic' }])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('dual-auth provider (anthropic): oauth failure offers api-key fallback (apiKeyAvailable=true)', async () => {
    // given: anthropic's OAuth login fails — distinct from openai-codex,
    //   where api-key fallback is unavailable. The recovery prompt MUST see
    //   apiKeyAvailable=true so the wizard can route to enter-api-key.
    let apiKeyAvailableSeen: boolean | undefined
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickProvider: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'browser closed' }),
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        apiKeyAvailableSeen = apiKeyAvailable
        return 'api-key'
      },
      askApiKey: async () => ({ kind: 'value', value: 'sk-ant-recovered' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(apiKeyAvailableSeen).toBe(true)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk-ant-recovered' })
  })
})

describe('recommended models', () => {
  function model(ref: ModelOption['ref'], overrides: Partial<ModelOption> = {}): ModelOption {
    const slash = ref.indexOf('/')
    const providerId = ref.slice(0, slash) as ModelOption['providerId']
    const modelId = ref.slice(slash + 1)
    return {
      ref,
      providerId,
      providerName: providerId,
      modelId,
      modelName: modelId,
      reasoning: false,
      contextWindow: null,
      curated: true,
      supportsVision: false,
      ...overrides,
    }
  }

  test('formatModelLabel marks gpt-5.4-mini under openai as Recommended', () => {
    const o = model('openai/gpt-5.4-mini', { modelName: 'GPT-5.4 mini' })
    expect(formatModelLabel(o)).toBe('GPT-5.4 mini (Recommended)')
  })

  test('formatModelLabel marks gpt-5.4-mini under openai-codex as Recommended', () => {
    const o = model('openai-codex/gpt-5.4-mini', { modelName: 'GPT-5.4 mini' })
    expect(formatModelLabel(o)).toBe('GPT-5.4 mini (Recommended)')
  })

  test('formatModelLabel marks claude-sonnet-4-6 as Recommended', () => {
    const o = model('anthropic/claude-sonnet-4-6', { modelName: 'Claude Sonnet 4.6' })
    expect(formatModelLabel(o)).toBe('Claude Sonnet 4.6 (Recommended)')
  })

  test('formatModelLabel leaves non-recommended models unchanged', () => {
    const o = model('openai/gpt-5.4', { modelName: 'GPT-5.4' })
    expect(formatModelLabel(o)).toBe('GPT-5.4')
  })

  test('sortRecommendedFirst floats the recommended OpenAI model to the top', () => {
    const nano = model('openai/gpt-5.4-nano', { modelName: 'GPT-5.4 nano' })
    const mini = model('openai/gpt-5.4-mini', { modelName: 'GPT-5.4 mini' })
    const full = model('openai/gpt-5.4', { modelName: 'GPT-5.4' })
    const sorted = sortRecommendedFirst([nano, mini, full])
    expect(sorted.map((o) => o.ref)).toEqual(['openai/gpt-5.4-mini', 'openai/gpt-5.4-nano', 'openai/gpt-5.4'])
  })

  test('sortRecommendedFirst floats the recommended Anthropic model to the top', () => {
    const haiku = model('anthropic/claude-haiku-4-5', { modelName: 'Claude Haiku 4.5' })
    const sonnet = model('anthropic/claude-sonnet-4-6', { modelName: 'Claude Sonnet 4.6' })
    const opus = model('anthropic/claude-opus-4-7', { modelName: 'Claude Opus 4.7' })
    const sorted = sortRecommendedFirst([haiku, sonnet, opus])
    expect(sorted.map((o) => o.ref)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-7',
    ])
  })

  test('sortRecommendedFirst preserves order when no model is recommended', () => {
    const a = model('openai/gpt-5.4-nano')
    const b = model('openai/gpt-5.4')
    const sorted = sortRecommendedFirst([a, b])
    expect(sorted.map((o) => o.ref)).toEqual(['openai/gpt-5.4-nano', 'openai/gpt-5.4'])
  })
})
