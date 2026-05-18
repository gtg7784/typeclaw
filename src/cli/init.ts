import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { cancel, confirm, intro, isCancel, log, note, password, select, spinner, text } from '@clack/prompts'
import { defineCommand } from 'citty'

import {
  KNOWN_PROVIDERS,
  supportsApiKey as providerSupportsApiKey,
  supportsOAuth as providerSupportsOAuth,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import type { DockerAvailability } from '@/container'
import {
  findAgentDir,
  hasExistingChannelSecrets,
  isDirectoryNonEmpty,
  isHatched,
  readExistingProviderApiKey,
  runInit,
  type GithubInitCredentials,
  type InitStep,
  type InitStepEvent,
  type KakaotalkAuthResult,
  type LLMAuth,
} from '@/init'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import { fetchModelOptions, type ModelOption } from '@/init/models-dev'
import { makeOAuthLoginRunner } from '@/init/oauth-login'

import { c, done, errorLine } from './ui'

// ESC and Ctrl+C both produce clack's cancel symbol (the keypress layer
// aliases both to the same "cancel" action — there's no way to tell them
// apart through @clack/prompts). The wizard treats every cancel as "go
// back to the previous step": each step that runs an interactive prompt
// either advances with a value or rewinds.
//
// Two cancel patterns must not trap the user:
//   1. Single-prompt cancel-loop. On the first step (pick-provider) there
//      is no previous step, so `back` re-displays the same prompt. Two
//      consecutive cancels on that same prompt = the user wants out.
//   2. Auto-advance round-trip. `back` from `enter-api-key` routes to
//      `pick-auth-method`, which for single-method providers (e.g.
//      Fireworks, api-key only) returns its value without prompting and
//      sends the wizard straight back to `enter-api-key`. The user only
//      ever sees the same api-key prompt and has no way to escape.
//
// Both patterns are detected in `collectWizardInputs` and surfaced as
// `WizardAbortedError`, which the `init` command catches and turns into
// a clean exit. Inside an active clack prompt Ctrl+C is still aliased to
// cancel, so the abort hotkey is "cancel twice in a row".
export class WizardAbortedError extends Error {
  constructor() {
    super('Wizard aborted by user')
    this.name = 'WizardAbortedError'
  }
}

export type StepResult<T> = { kind: 'value'; value: T; auto?: boolean } | { kind: 'back' }
const back = <T>(): StepResult<T> => ({ kind: 'back' })
const value = <T>(v: T): StepResult<T> => ({ kind: 'value', value: v })
const autoValue = <T>(v: T): StepResult<T> => ({ kind: 'value', value: v, auto: true })

export const init = defineCommand({
  meta: {
    name: 'init',
    description: 'initialize a new typeclaw agent in the current directory',
  },
  async run() {
    const cwd = process.cwd()

    const existingAgent = findAgentDir(cwd)
    if (existingAgent !== null && existingAgent !== cwd) {
      console.error(
        errorLine(
          `Refusing to init: a TypeClaw agent already exists at ${existingAgent}. Nested agents are not supported.`,
        ),
      )
      process.exit(1)
    }

    if (await isHatched(cwd)) {
      console.error(errorLine(`TypeClaw has already hatched in ${cwd}.`))
      process.exit(1)
    }

    if (isDirectoryNonEmpty(cwd)) {
      const proceed = await confirm({
        message: `You're at ${cwd}. The directory is not empty. Do you want to proceed?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    intro('Initializing TypeClaw...')
    log.info('Press ESC at any prompt to go back. Press ESC twice in a row to abort.')

    let collected: CollectedInputs
    try {
      collected = await collectWizardInputs(cwd, defaultWizardPrompts)
    } catch (error) {
      if (error instanceof WizardAbortedError) {
        cancel('Aborted.')
        process.exit(0)
      }
      throw error
    }
    const { model, llmAuth, vision, channelChoice, reuseExistingChannel, channelSecrets } = collected
    const {
      discordBotToken,
      slackBotToken,
      slackAppToken,
      telegramBotToken,
      kakaotalkEmail,
      kakaotalkPassword,
      github: githubCredentials,
    } = channelSecrets

    // TODO: add remaining wizard steps from TypeClaw.md once their runtime lands:
    //   - git backup (url + PAT) — Phase 10
    //   - cron.json scaffolding — Phase 9
    //   - compose.yml registration in $HOME/.typeclaw — Phase 12

    // Reuse means: wire the adapter in typeclaw.json but skip the prompt for
    // fresh tokens / fresh kakaotalk login. `with<Adapter>` flags carry that
    // intent down to scaffold(); writeSecrets / runKakaotalkAuth see no new
    // input and leave the existing secrets.json slot untouched.
    const reuseDiscord = reuseExistingChannel && channelChoice === 'discord'
    const reuseSlack = reuseExistingChannel && channelChoice === 'slack'
    const reuseTelegram = reuseExistingChannel && channelChoice === 'telegram'
    const reuseKakaotalk = reuseExistingChannel && channelChoice === 'kakaotalk'
    const reuseGithub = reuseExistingChannel && channelChoice === 'github'
    const wantsKakaotalk = (kakaotalkEmail !== undefined && kakaotalkPassword !== undefined) || reuseKakaotalk
    const wantsGithub = githubCredentials !== undefined || reuseGithub
    let hatchingOk = false
    let preflightFailure: Extract<DockerAvailability, { ok: false }> | null = null
    try {
      await runInit({
        cwd,
        llmAuth,
        model: model.ref,
        ...(vision !== undefined ? { visionModel: vision.model.ref, visionAuth: vision.llmAuth } : {}),
        cliEntry: process.argv[1],
        ...(discordBotToken !== undefined ? { discordBotToken } : {}),
        ...(slackBotToken !== undefined ? { slackBotToken, slackAppToken } : {}),
        ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
        ...(reuseDiscord ? { withDiscord: true } : {}),
        ...(reuseSlack ? { withSlack: true } : {}),
        ...(reuseTelegram ? { withTelegram: true } : {}),
        ...(wantsKakaotalk
          ? {
              withKakaotalk: true,
              ...(reuseKakaotalk
                ? {}
                : {
                    runKakaotalkAuth: ({ cwd: agentDir }) =>
                      runKakaotalkBootstrap({
                        email: kakaotalkEmail!,
                        password: kakaotalkPassword!,
                        agentDir,
                        callbacks: {
                          onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
                        },
                      }),
                  }),
            }
          : {}),
        ...(wantsGithub
          ? {
              withGithub: true,
              ...(reuseGithub || githubCredentials === undefined ? {} : { githubCredentials }),
            }
          : {}),
        onProgress: reportProgress(
          (ok) => {
            hatchingOk = ok
          },
          (result) => {
            preflightFailure = result
          },
        ),
      })
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)))
      process.exit(1)
    }

    if (preflightFailure !== null) {
      note(preflightFailureGuidance(preflightFailure).join('\n'), 'Docker check failed')
      process.exit(1)
    }

    if (hatchingOk) {
      done({
        title: c.green('Hatched. Your agent is ready.'),
        hints: [
          { label: 'Attach TUI:', command: 'typeclaw tui' },
          { label: 'Follow logs:', command: 'typeclaw logs -f' },
          { label: 'Stop:', command: 'typeclaw stop' },
        ],
      })
    }
  },
})

interface WizardState {
  catalog?: { options: ModelOption[]; source: 'models.dev' | 'curated'; warning?: string }
  providerId?: KnownProviderId
  model?: ModelOption
  reuseExisting?: boolean
  authMethod?: 'api-key' | 'oauth'
  llmAuth?: LLMAuth
  visionProviderId?: KnownProviderId
  visionModel?: ModelOption
  visionReuseExisting?: boolean
  visionAuthMethod?: 'api-key' | 'oauth'
  visionLlmAuth?: LLMAuth
  channelChoice?: ChannelChoice
  channelReuseOffered?: boolean
  channelReuseExisting?: boolean
}

type ChannelChoice = 'slack' | 'discord' | 'telegram' | 'kakaotalk' | 'github' | 'none'

interface CollectedInputs {
  model: ModelOption
  llmAuth: LLMAuth
  // Set only when the default model is text-only and the user picked a
  // vision-capable model for the `vision` profile. `llmAuth` is reused from
  // the default provider's credentials when the vision provider matches, so
  // tests can still mint a single auth object and have it cover both.
  vision?: {
    model: ModelOption
    llmAuth: LLMAuth
  }
  channelChoice: ChannelChoice
  reuseExistingChannel: boolean
  channelSecrets: {
    discordBotToken?: string
    slackBotToken?: string
    slackAppToken?: string
    telegramBotToken?: string
    kakaotalkEmail?: string
    kakaotalkPassword?: string
    // Structured (auth union + webhook + repo allowlist) rather than flat
    // tokens, so it rides as one sub-object instead of sibling fields.
    // `runInit` delegates to `runAddChannel` for GitHub to keep the github
    // config-writing in one place.
    github?: GithubInitCredentials
  }
}

type StepId =
  | 'pick-provider'
  | 'pick-model'
  | 'reuse-existing-key'
  | 'pick-auth-method'
  | 'enter-api-key'
  | 'pick-vision-provider'
  | 'pick-vision-model'
  | 'pick-vision-auth-method'
  | 'enter-vision-api-key'
  | 'pick-channel'
  | 'reuse-existing-channel'
  | 'channel-flow'

export interface WizardPrompts {
  loadCatalog: () => Promise<NonNullable<WizardState['catalog']>>
  readExistingApiKey: (cwd: string, providerId: KnownProviderId) => Promise<string | null>
  pickProvider: (options: ModelOption[], initial: KnownProviderId | undefined) => Promise<StepResult<KnownProviderId>>
  pickModel: (
    options: ModelOption[],
    providerId: KnownProviderId,
    initial: KnownModelRef | undefined,
  ) => Promise<StepResult<ModelOption>>
  askReuseExistingKey: (
    provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
    existingApiKey: string | null,
    initial: boolean | undefined,
  ) => Promise<StepResult<'reuse' | 'prompt'>>
  pickAuthMethod: (
    provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
    initial: 'api-key' | 'oauth' | undefined,
  ) => Promise<StepResult<'api-key' | 'oauth'>>
  askApiKey: (provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]) => Promise<StepResult<string>>
  pickVisionProvider: (
    options: ModelOption[],
    initial: KnownProviderId | undefined,
  ) => Promise<StepResult<KnownProviderId | 'skip'>>
  pickVisionModel: (
    options: ModelOption[],
    providerId: KnownProviderId,
    initial: KnownModelRef | undefined,
  ) => Promise<StepResult<ModelOption>>
  pickChannel: (initial: ChannelChoice | undefined) => Promise<StepResult<ChannelChoice>>
  hasExistingChannelSecrets: (cwd: string, channel: Exclude<ChannelChoice, 'none'>) => Promise<boolean>
  askReuseExistingChannel: (channel: Exclude<ChannelChoice, 'none'>) => Promise<StepResult<'reuse' | 'prompt'>>
  runChannelFlow: (choice: ChannelChoice) => Promise<StepResult<CollectedInputs['channelSecrets']>>
  buildOAuthAuth: (provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]) => LLMAuth
}

export const defaultWizardPrompts: WizardPrompts = {
  loadCatalog,
  readExistingApiKey: readExistingProviderApiKey,
  pickProvider,
  pickModel: pickModelForProvider,
  askReuseExistingKey,
  pickAuthMethod,
  askApiKey,
  pickVisionProvider,
  pickVisionModel,
  pickChannel,
  hasExistingChannelSecrets,
  askReuseExistingChannel,
  runChannelFlow,
  buildOAuthAuth: (provider) => ({
    kind: 'oauth',
    runLogin: makeOAuthLoginRunner(buildOAuthCallbacks(provider.name)),
  }),
}

export async function collectWizardInputs(cwd: string, prompts: WizardPrompts): Promise<CollectedInputs> {
  const catalog = await prompts.loadCatalog()
  const state: WizardState = { catalog }
  let step: StepId = 'pick-provider'
  let pendingBackOrigin: StepId | null = null

  const onResult = <T>(currentStep: StepId, result: StepResult<T>): StepResult<T> => {
    if (result.kind === 'back') {
      if (pendingBackOrigin === currentStep) throw new WizardAbortedError()
      pendingBackOrigin = currentStep
    } else if (!result.auto) {
      pendingBackOrigin = null
    }
    return result
  }

  while (true) {
    switch (step) {
      case 'pick-provider': {
        const result = onResult(step, await prompts.pickProvider(catalog.options, state.providerId))
        if (result.kind === 'back') {
          break
        }
        if (state.providerId !== result.value) {
          state.model = undefined
          state.reuseExisting = undefined
          state.authMethod = undefined
          state.llmAuth = undefined
        }
        state.providerId = result.value
        step = 'pick-model'
        break
      }

      case 'pick-model': {
        const result = onResult(step, await prompts.pickModel(catalog.options, state.providerId!, state.model?.ref))
        if (result.kind === 'back') {
          step = 'pick-provider'
          break
        }
        state.model = result.value
        step = 'reuse-existing-key'
        break
      }

      case 'reuse-existing-key': {
        const provider = KNOWN_PROVIDERS[state.providerId!]
        const existingApiKey = await prompts.readExistingApiKey(cwd, state.providerId!)
        const decision = onResult(
          step,
          await prompts.askReuseExistingKey(provider, existingApiKey, state.reuseExisting),
        )
        if (decision.kind === 'back') {
          step = 'pick-model'
          break
        }
        if (decision.value === 'reuse' && existingApiKey !== null) {
          log.info(`Using existing ${provider.name} API key from secrets.json.`)
          state.llmAuth = { kind: 'api-key', apiKey: existingApiKey }
          state.reuseExisting = true
          step = stepAfterDefaultAuth(state)
          break
        }
        state.reuseExisting = false
        state.llmAuth = undefined
        step = 'pick-auth-method'
        break
      }

      case 'pick-auth-method': {
        const provider = KNOWN_PROVIDERS[state.providerId!]
        const result = onResult(step, await prompts.pickAuthMethod(provider, state.authMethod))
        if (result.kind === 'back') {
          step = 'reuse-existing-key'
          break
        }
        state.authMethod = result.value
        if (result.value === 'oauth') {
          state.llmAuth = prompts.buildOAuthAuth(provider)
          step = stepAfterDefaultAuth(state)
        } else {
          step = 'enter-api-key'
        }
        break
      }

      case 'enter-api-key': {
        const provider = KNOWN_PROVIDERS[state.providerId!]
        const result = onResult(step, await prompts.askApiKey(provider))
        if (result.kind === 'back') {
          step = 'pick-auth-method'
          break
        }
        state.llmAuth = { kind: 'api-key', apiKey: result.value }
        step = stepAfterDefaultAuth(state)
        break
      }

      case 'pick-vision-provider': {
        const visionOptions = catalog.options.filter((o) => o.supportsVision)
        const result = onResult(step, await prompts.pickVisionProvider(visionOptions, state.visionProviderId))
        if (result.kind === 'back') {
          step = stepBeforeVision(state)
          break
        }
        if (result.value === 'skip') {
          state.visionProviderId = undefined
          state.visionModel = undefined
          state.visionLlmAuth = undefined
          state.visionReuseExisting = undefined
          state.visionAuthMethod = undefined
          step = 'pick-channel'
          break
        }
        if (state.visionProviderId !== result.value) {
          state.visionModel = undefined
          state.visionReuseExisting = undefined
          state.visionAuthMethod = undefined
          state.visionLlmAuth = undefined
        }
        state.visionProviderId = result.value
        step = 'pick-vision-model'
        break
      }

      case 'pick-vision-model': {
        const visionOptions = catalog.options.filter((o) => o.supportsVision)
        const result = onResult(
          step,
          await prompts.pickVisionModel(visionOptions, state.visionProviderId!, state.visionModel?.ref),
        )
        if (result.kind === 'back') {
          step = 'pick-vision-provider'
          break
        }
        state.visionModel = result.value
        if (state.visionProviderId === state.providerId) {
          log.info(`Using ${KNOWN_PROVIDERS[state.providerId!].name} credentials for the vision profile.`)
          state.visionLlmAuth = state.llmAuth
          state.visionReuseExisting = true
          step = 'pick-channel'
          break
        }
        const existingVisionKey = await prompts.readExistingApiKey(cwd, state.visionProviderId!)
        if (existingVisionKey !== null) {
          log.info(`Using existing ${KNOWN_PROVIDERS[state.visionProviderId!].name} API key from secrets.json.`)
          state.visionLlmAuth = { kind: 'api-key', apiKey: existingVisionKey }
          state.visionReuseExisting = true
          step = 'pick-channel'
          break
        }
        state.visionReuseExisting = false
        state.visionLlmAuth = undefined
        step = 'pick-vision-auth-method'
        break
      }

      case 'pick-vision-auth-method': {
        const provider = KNOWN_PROVIDERS[state.visionProviderId!]
        const result = onResult(step, await prompts.pickAuthMethod(provider, state.visionAuthMethod))
        if (result.kind === 'back') {
          step = 'pick-vision-model'
          break
        }
        state.visionAuthMethod = result.value
        if (result.value === 'oauth') {
          state.visionLlmAuth = prompts.buildOAuthAuth(provider)
          step = 'pick-channel'
        } else {
          step = 'enter-vision-api-key'
        }
        break
      }

      case 'enter-vision-api-key': {
        const provider = KNOWN_PROVIDERS[state.visionProviderId!]
        const result = onResult(step, await prompts.askApiKey(provider))
        if (result.kind === 'back') {
          step = 'pick-vision-auth-method'
          break
        }
        state.visionLlmAuth = { kind: 'api-key', apiKey: result.value }
        step = 'pick-channel'
        break
      }

      case 'pick-channel': {
        const result: StepResult<ChannelChoice> = onResult(step, await prompts.pickChannel(state.channelChoice))
        if (result.kind === 'back') {
          step = stepBeforePickChannel(state)
          break
        }
        if (state.channelChoice !== result.value) {
          state.channelReuseOffered = undefined
          state.channelReuseExisting = undefined
        }
        state.channelChoice = result.value
        step = result.value === 'none' ? 'channel-flow' : 'reuse-existing-channel'
        break
      }

      case 'reuse-existing-channel': {
        const choice = state.channelChoice as Exclude<ChannelChoice, 'none'>
        const present = await prompts.hasExistingChannelSecrets(cwd, choice)
        if (!present) {
          state.channelReuseOffered = false
          state.channelReuseExisting = false
          step = 'channel-flow'
          break
        }
        state.channelReuseOffered = true
        const decision = onResult(step, await prompts.askReuseExistingChannel(choice))
        if (decision.kind === 'back') {
          step = 'pick-channel'
          break
        }
        if (decision.value === 'reuse') {
          log.info(`Using existing ${channelDisplayName(choice)} credentials from secrets.json.`)
          state.channelReuseExisting = true
          return finalize(state, {})
        }
        state.channelReuseExisting = false
        step = 'channel-flow'
        break
      }

      case 'channel-flow': {
        const result = onResult(step, await prompts.runChannelFlow(state.channelChoice!))
        if (result.kind === 'back') {
          step = state.channelReuseOffered === true ? 'reuse-existing-channel' : 'pick-channel'
          break
        }
        return finalize(state, result.value)
      }
    }
  }
}

function finalize(state: WizardState, channelSecrets: CollectedInputs['channelSecrets']): CollectedInputs {
  return {
    model: state.model!,
    llmAuth: state.llmAuth!,
    ...(state.visionModel !== undefined && state.visionLlmAuth !== undefined
      ? { vision: { model: state.visionModel, llmAuth: state.visionLlmAuth } }
      : {}),
    channelChoice: state.channelChoice ?? 'none',
    reuseExistingChannel: state.channelReuseExisting === true,
    channelSecrets,
  }
}

function channelDisplayName(choice: Exclude<ChannelChoice, 'none'>): string {
  switch (choice) {
    case 'slack':
      return 'Slack'
    case 'discord':
      return 'Discord'
    case 'telegram':
      return 'Telegram'
    case 'kakaotalk':
      return 'KakaoTalk'
    case 'github':
      return 'GitHub'
  }
}

function stepAfterDefaultAuth(state: WizardState): StepId {
  return state.model?.supportsVision === false ? 'pick-vision-provider' : 'pick-channel'
}

function stepBeforeVision(state: WizardState): StepId {
  if (state.reuseExisting === true) return 'reuse-existing-key'
  if (state.authMethod === 'api-key') return 'enter-api-key'
  return 'pick-auth-method'
}

function stepBeforePickChannel(state: WizardState): StepId {
  if (state.visionModel !== undefined) {
    if (state.visionProviderId === state.providerId) return 'pick-vision-model'
    if (state.visionReuseExisting === true) return 'pick-vision-model'
    if (state.visionAuthMethod === 'api-key') return 'enter-vision-api-key'
    if (state.visionAuthMethod === 'oauth') return 'pick-vision-auth-method'
    return 'pick-vision-model'
  }
  if (state.model?.supportsVision === false) return 'pick-vision-provider'
  return stepBeforeVision(state)
}

async function loadCatalog(): Promise<NonNullable<WizardState['catalog']>> {
  const s = spinner()
  s.start('Loading model catalog from models.dev...')
  const { options, source, warning } = await fetchModelOptions()
  if (source === 'curated') {
    s.stop(`Using built-in catalog (models.dev unavailable: ${warning ?? 'unknown'})`)
  } else {
    s.stop('Loaded model catalog.')
  }
  return warning !== undefined ? { options, source, warning } : { options, source }
}

async function pickProvider(
  options: ModelOption[],
  initial: KnownProviderId | undefined,
): Promise<StepResult<KnownProviderId>> {
  const providers = uniqueProviders(options)
  const choice = await select({
    message: 'Pick an LLM provider',
    options: providers.map((id) => ({ value: id, label: KNOWN_PROVIDERS[id].name, hint: providerAuthHint(id) })),
    initialValue: initial ?? providers[0],
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function pickModelForProvider(
  options: ModelOption[],
  providerId: KnownProviderId,
  initial: KnownModelRef | undefined,
): Promise<StepResult<ModelOption>> {
  const candidates = options.filter((o) => o.providerId === providerId)
  const choice = await select<KnownModelRef>({
    message: `Pick a ${KNOWN_PROVIDERS[providerId].name} model`,
    options: candidates.map((o) => ({
      value: o.ref,
      label: o.modelName,
      hint: formatModelHint(o),
    })),
    initialValue: initial ?? candidates[0]?.ref,
  })
  if (isCancel(choice)) return back()
  const picked = candidates.find((o) => o.ref === choice)
  if (!picked) throw new Error(`Internal error: picked model ${choice} not in candidates`)
  return value(picked)
}

async function askReuseExistingKey(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  existingApiKey: string | null,
  initial: boolean | undefined,
): Promise<StepResult<'reuse' | 'prompt'>> {
  if (!providerSupportsApiKey(provider) || existingApiKey === null) return value('prompt')
  const reuse = await confirm({
    message: `Reuse existing ${provider.name} API key from secrets.json?`,
    initialValue: initial ?? true,
  })
  if (isCancel(reuse)) return back()
  return value(reuse === true ? 'reuse' : 'prompt')
}

async function askReuseExistingChannel(
  channel: Exclude<ChannelChoice, 'none'>,
): Promise<StepResult<'reuse' | 'prompt'>> {
  const reuse = await confirm({
    message: `Reuse existing ${channelDisplayName(channel)} credentials from secrets.json?`,
    initialValue: true,
  })
  if (isCancel(reuse)) return back()
  return value(reuse === true ? 'reuse' : 'prompt')
}

async function pickAuthMethod(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  initial: 'api-key' | 'oauth' | undefined,
): Promise<StepResult<'api-key' | 'oauth'>> {
  const supportsApiKey = providerSupportsApiKey(provider)
  const supportsOAuth = providerSupportsOAuth(provider)
  if (supportsApiKey && supportsOAuth) {
    const choice = await select<'api-key' | 'oauth'>({
      message: `How do you want to authenticate to ${provider.name}?`,
      options: [
        { value: 'api-key', label: 'API key', hint: 'saved to secrets.json' },
        { value: 'oauth', label: 'OAuth (browser login)', hint: 'saved to secrets.json' },
      ],
      initialValue: initial ?? 'api-key',
    })
    if (isCancel(choice)) return back()
    return value(choice)
  }
  return autoValue(supportsOAuth ? 'oauth' : 'api-key')
}

async function pickVisionProvider(
  options: ModelOption[],
  initial: KnownProviderId | undefined,
): Promise<StepResult<KnownProviderId | 'skip'>> {
  const providers = uniqueProviders(options)
  if (providers.length === 0) {
    log.warn('No vision-capable models available; skipping vision profile.')
    return autoValue('skip')
  }
  const choice = await select<KnownProviderId | 'skip'>({
    message: 'Your model is text-only. Pick a provider for the `vision` profile (used for image input)',
    options: [
      ...providers.map((id) => ({
        value: id as KnownProviderId | 'skip',
        label: KNOWN_PROVIDERS[id].name,
        hint: providerAuthHint(id),
      })),
      { value: 'skip', label: 'Skip — no vision support', hint: 'add later with `typeclaw model set vision <ref>`' },
    ],
    initialValue: initial ?? providers[0],
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function pickVisionModel(
  options: ModelOption[],
  providerId: KnownProviderId,
  initial: KnownModelRef | undefined,
): Promise<StepResult<ModelOption>> {
  const candidates = options.filter((o) => o.providerId === providerId)
  const choice = await select<KnownModelRef>({
    message: `Pick a vision-capable ${KNOWN_PROVIDERS[providerId].name} model`,
    options: candidates.map((o) => ({
      value: o.ref,
      label: o.modelName,
      hint: formatModelHint(o),
    })),
    initialValue: initial ?? candidates[0]?.ref,
  })
  if (isCancel(choice)) return back()
  const picked = candidates.find((o) => o.ref === choice)
  if (!picked) throw new Error(`Internal error: picked vision model ${choice} not in candidates`)
  return value(picked)
}

async function askApiKey(provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]): Promise<StepResult<string>> {
  const apiKey = await password({
    message: `Put your ${provider.name} API key (will be saved to secrets.json)`,
    validate: (v) => (v && v.length > 0 ? undefined : 'API key is required'),
  })
  if (isCancel(apiKey)) return back()
  return value(apiKey)
}

async function pickChannel(initial: ChannelChoice | undefined): Promise<StepResult<ChannelChoice>> {
  const choice = await select<ChannelChoice>({
    message: 'Pick a channel to wire (you can add more later by editing typeclaw.json + secrets.json)',
    options: [
      { value: 'slack', label: 'Slack' },
      { value: 'discord', label: 'Discord' },
      { value: 'telegram', label: 'Telegram' },
      { value: 'kakaotalk', label: 'KakaoTalk' },
      { value: 'github', label: 'GitHub' },
      { value: 'none', label: 'Skip — no channel right now' },
    ],
    initialValue: initial ?? 'slack',
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function runChannelFlow(choice: ChannelChoice): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  switch (choice) {
    case 'none':
      return value({})
    case 'discord':
      return runDiscordFlow()
    case 'kakaotalk':
      return runKakaotalkFlow()
    case 'slack':
      return runSlackFlow()
    case 'telegram':
      return runTelegramFlow()
    case 'github':
      return runGithubFlow()
  }
}

async function runDiscordFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'https://discord.com/developers/applications',
      'New Application → Bot tab → Reset Token.',
      'Enable the MESSAGE CONTENT intent.',
    ].join('\n'),
    'Get a Discord bot token',
  )
  const token = await password({
    message: 'Discord bot token',
    validate: (v) => (v && v.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) return back()
  return value({ discordBotToken: token })
}

async function runKakaotalkFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  // Sub-flow with its own back-aware loop: ESC on the password prompt
  // returns to the email prompt; ESC on the email prompt unwinds to the
  // channel picker.
  type SubStep = 'email' | 'password'
  let sub: SubStep = 'email'
  let email: string | undefined
  let pwd: string | undefined

  note(
    [
      'KakaoTalk authentication uses a personal account, registered as a',
      'tablet sub-device. Messages will be sent and received under this',
      'account. Use a non-primary account if possible.',
      '',
      'After you submit the password, KakaoTalk may ask you to confirm a',
      'passcode on your phone. Watch the screen for the code.',
    ].join('\n'),
    'About to log in to KakaoTalk',
  )

  while (true) {
    if (sub === 'email') {
      const input = await text({
        message: 'KakaoTalk email',
        ...(email !== undefined ? { initialValue: email } : {}),
        validate: (v) => (v && v.length > 0 ? undefined : 'Email is required'),
      })
      if (isCancel(input)) return back()
      email = input
      sub = 'password'
      continue
    }
    const input = await password({
      message: 'KakaoTalk password',
      validate: (v) => (v && v.length > 0 ? undefined : 'Password is required'),
    })
    if (isCancel(input)) {
      sub = 'email'
      continue
    }
    pwd = input
    return value({ kakaotalkEmail: email, kakaotalkPassword: pwd })
  }
}

async function runSlackFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  type SubStep = 'bot' | 'app'
  let sub: SubStep = 'bot'
  let botToken: string | undefined

  note(
    [
      '1. https://api.slack.com/apps → Create New App → From a manifest.',
      '   Pick your workspace, then paste this JSON manifest:',
      '',
      '   {',
      '     "display_information": { "name": "TypeClaw" },',
      '     "features": {',
      '       "bot_user": { "display_name": "TypeClaw", "always_online": true }',
      '     },',
      '     "oauth_config": {',
      '       "scopes": {',
      '         "bot": [',
      '           "app_mentions:read", "chat:write", "users:read", "files:read",',
      '           "channels:history", "channels:read",',
      '           "groups:history",   "groups:read",',
      '           "im:history",       "im:read",',
      '           "mpim:history",     "mpim:read"',
      '         ]',
      '       }',
      '     },',
      '     "settings": {',
      '       "event_subscriptions": {',
      '         "bot_events": [',
      '           "app_mention",',
      '           "message.channels", "message.groups",',
      '           "message.im",       "message.mpim"',
      '         ]',
      '       },',
      '       "socket_mode_enabled": true',
      '     }',
      '   }',
      '',
      '2. Install to Workspace, then OAuth & Permissions →',
      '   copy the Bot User OAuth Token (xoxb-...).',
      '3. Basic Information → App-Level Tokens → Generate Token and',
      '   Scopes, add the connections:write scope, and copy the',
      '   token (xapp-...). Socket Mode needs this; the manifest',
      '   cannot grant it.',
      '4. Invite the bot to any private channel or DM you want it in:',
      '   /invite @TypeClaw',
    ].join('\n'),
    'Get a Slack bot',
  )

  while (true) {
    if (sub === 'bot') {
      const input = await password({
        message: 'Slack bot token (xoxb-...)',
        validate: (v) =>
          v && v.length > 0
            ? v.startsWith('xoxb-')
              ? undefined
              : 'Bot token must start with "xoxb-"'
            : 'Token is required',
      })
      if (isCancel(input)) return back()
      botToken = input
      note(
        [
          'Slack does not accept connections:write inside the manifest, so',
          'this token has to be generated by hand:',
          '',
          '1. Basic Information → App-Level Tokens → Generate Token and Scopes.',
          '2. Token Name: anything (e.g. "socket-mode").',
          '3. Add Scope → connections:write → Generate.',
          '4. Copy the xapp-... token shown once on screen.',
          '   (You cannot retrieve it later — only revoke and regenerate.)',
        ].join('\n'),
        'Generate the Slack app-level token',
      )
      sub = 'app'
      continue
    }
    const input = await password({
      message: 'Slack app-level token (xapp-...) — Socket Mode requires this',
      validate: (v) =>
        v && v.length > 0
          ? v.startsWith('xapp-')
            ? undefined
            : 'App-level token must start with "xapp-"'
          : 'Token is required',
    })
    if (isCancel(input)) {
      sub = 'bot'
      continue
    }
    return value({ slackBotToken: botToken!, slackAppToken: input })
  }
}

async function runGithubFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'Choose PAT auth for a quick setup, or GitHub App auth for expiring installation tokens.',
      'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
      'Metadata read, and Webhooks read/write (TypeClaw will create and manage the repository webhooks for you).',
    ].join('\n'),
    'Get GitHub credentials',
  )
  const authType = await select<'pat' | 'app'>({
    message: 'GitHub authentication type',
    options: [
      { value: 'pat', label: 'Fine-grained personal access token' },
      { value: 'app', label: 'GitHub App installation token' },
    ],
  })
  if (isCancel(authType)) return back()
  const auth = authType === 'pat' ? await promptGithubPatAuth() : await promptGithubAppAuth()
  if (auth === null) return back()
  const webhookUrl = await text({
    message: 'Public webhook URL (GitHub will POST events here)',
    validate: (v) => validateGithubUrl(v ?? '', 'Webhook URL is required'),
  })
  if (isCancel(webhookUrl)) return back()
  const port = await text({
    message: 'Local webhook port inside the agent container',
    initialValue: '8975',
    validate: (v) => {
      const parsed = Number(v)
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Port must be a positive integer'
    },
  })
  if (isCancel(port)) return back()
  const secret = await password({
    message: 'Webhook secret (leave blank to auto-generate)',
  })
  if (isCancel(secret)) return back()
  // clack's password() returns `undefined` on an empty submission (it has no
  // validate guard and never coerces to ''), so we normalize before the
  // length checks below to avoid a TypeError on the "leave blank" path.
  const enteredSecret = typeof secret === 'string' ? secret : ''
  const reposRaw = await text({
    message: 'Repositories to allow (comma-separated owner/repo)',
    validate: (v) => (parseGithubRepos(v ?? '').length > 0 ? undefined : 'At least one owner/repo is required'),
  })
  if (isCancel(reposRaw)) return back()
  const resolvedSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  return value({
    github: {
      webhookSecret: resolvedSecret,
      webhookUrl,
      webhookPort: Number(port),
      repos: parseGithubRepos(reposRaw),
      auth,
    },
  })
}

async function promptGithubPatAuth(): Promise<{ type: 'pat'; pat: string } | null> {
  const pat = await password({
    message: 'GitHub fine-grained PAT',
    validate: (v) => (v && v.length > 0 ? undefined : 'PAT is required'),
  })
  if (isCancel(pat)) return null
  return { type: 'pat', pat }
}

async function promptGithubAppAuth(): Promise<{
  type: 'app'
  appId: number
  privateKey: string
  installationId?: number
} | null> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (v) => validatePositiveInteger(v ?? '', 'App ID is required'),
  })
  if (isCancel(appId)) return null
  const privateKeyInput = await text({
    message: 'GitHub App private key PEM, escaped PEM, or path to .pem file',
    validate: (v) => (v && v.length > 0 ? undefined : 'Private key is required'),
  })
  if (isCancel(privateKeyInput)) return null
  const installationId = await text({
    message: 'Installation ID (optional; leave blank to auto-discover)',
    validate: (v) =>
      v === undefined || v === '' ? undefined : validatePositiveInteger(v, 'Installation ID is required'),
  })
  if (isCancel(installationId)) return null
  const parsedInstallationId = installationId === '' ? undefined : Number(installationId)
  return {
    type: 'app',
    appId: Number(appId),
    privateKey: await resolveGithubPrivateKey(privateKeyInput),
    ...(parsedInstallationId !== undefined ? { installationId: parsedInstallationId } : {}),
  }
}

async function resolveGithubPrivateKey(input: string): Promise<string> {
  const normalized = input.replace(/\\n/g, '\n')
  if (normalized.includes('-----BEGIN') && normalized.includes('PRIVATE KEY-----')) return normalized
  return await readFile(input, 'utf8')
}

function parseGithubRepos(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v))
}

function validateGithubUrl(v: string, requiredMessage: string): string | undefined {
  if (!v || v.length === 0) return requiredMessage
  try {
    new URL(v)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validatePositiveInteger(v: string, requiredMessage: string): string | undefined {
  if (!v || v.length === 0) return requiredMessage
  const parsed = Number(v)
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
}

async function runTelegramFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'Open Telegram and message @BotFather.',
      '/newbot → pick a name and username, copy the HTTP API token',
      '  (looks like 1234567890:ABCdef...).',
      'In @BotFather: /setprivacy → Disable, so the bot can see group messages.',
    ].join('\n'),
    'Get a Telegram bot token',
  )
  const token = await password({
    message: 'Telegram bot token',
    validate: (v) =>
      v && v.length > 0
        ? /^\d+:/.test(v)
          ? undefined
          : 'Bot token must look like "<digits>:<secret>" (from @BotFather)'
        : 'Token is required',
  })
  if (isCancel(token)) return back()
  note(
    [
      'Open https://t.me/<your_bot_username> (the username you picked in /newbot, ends in "bot").',
      'Tap Start in the chat — the agent will reply once it hatches.',
      'For groups: add the bot to the group, then @mention it or reply to its messages.',
    ].join('\n'),
    'Send your first message',
  )
  return value({ telegramBotToken: token })
}

function reportProgress(
  onHatchingDone: (ok: boolean) => void,
  onPreflightFail: (result: Extract<DockerAvailability, { ok: false }>) => void,
): (event: InitStepEvent) => void {
  const spinners: Partial<Record<InitStepEvent['step'], ReturnType<typeof spinner>>> = {}

  return (event) => {
    if (event.step === 'hatching') {
      reportHatching(event)
      if (event.phase === 'done') onHatchingDone(event.result.ok)
      return
    }

    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'preflight':
        if (event.result.ok) {
          s.stop('Docker is reachable.')
        } else {
          s.error(preflightFailureSummary(event.result))
          onPreflightFail(event.result)
        }
        break
      case 'scaffold':
        s.stop('Egg laid. 🥚')
        break
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'oauth-login':
        s.stop(event.result.ok ? 'Logged in.' : `OAuth login failed: ${event.result.reason}`)
        break
      case 'install':
        s.stop(event.result.ok ? 'Dependencies installed.' : `Skipped bun install: ${event.result.reason}`)
        break
      case 'dockerfile':
        if (event.result.ok) {
          s.stop(event.result.devMode ? 'Dockerfile written (dev mode).' : 'Dockerfile written.')
        } else {
          s.stop(`Skipped Dockerfile: ${event.result.reason}`)
        }
        break
      case 'git':
        if (event.result.ok) {
          s.stop(event.result.skipped ? 'Git repository already exists.' : 'Git repository initialized.')
        } else {
          s.stop(`Skipped git init: ${event.result.reason}`)
        }
        break
    }
  }
}

function preflightFailureSummary(result: Extract<DockerAvailability, { ok: false }>): string {
  if (result.reason === 'binary-missing') return 'Docker is not installed.'
  return 'Docker is installed but the daemon is not reachable.'
}

function preflightFailureGuidance(result: Extract<DockerAvailability, { ok: false }>): string[] {
  if (result.reason === 'binary-missing') {
    return [
      'TypeClaw runs every agent inside its own Docker container, so Docker is required.',
      '',
      'Install one of:',
      '  • Docker Desktop — https://docs.docker.com/get-docker/',
      '  • OrbStack (macOS, lighter) — https://orbstack.dev',
      '',
      'Then re-run `typeclaw init`.',
    ]
  }
  return [
    'The docker CLI is on $PATH, but the daemon refused the connection:',
    '',
    `  ${result.detail}`,
    '',
    'Start Docker Desktop / OrbStack (or `sudo systemctl start docker` on Linux),',
    'then re-run `typeclaw init`.',
  ]
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to secrets.json.'
  return `KakaoTalk login failed: ${result.reason}`
}

// Hatching launches the container and foregrounds the TUI, so it steals stdin
// and cannot share the spinner lifecycle with the other steps. Print plain
// lines instead.
function reportHatching(event: Extract<InitStepEvent, { step: 'hatching' }>): void {
  if (event.phase === 'start') {
    console.log('Hatching...')
    return
  }
  if (event.result.ok) {
    console.log('Hatched. 🐣')
  } else {
    console.error(errorLine(`Hatching failed: ${event.result.reason}`))
  }
}

export async function decideExistingApiKeyReuse(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  existingApiKey: string | null,
  askReuse: (message: string) => Promise<unknown>,
): Promise<'reuse' | 'prompt' | 'cancel'> {
  if (!providerSupportsApiKey(provider) || existingApiKey === null) return 'prompt'

  const reuse = await askReuse(`Reuse existing ${provider.name} API key from secrets.json?`)
  if (isCancel(reuse)) return 'cancel'
  return reuse === true ? 'reuse' : 'prompt'
}

// Wraps the OAuth lifecycle into the same clack idiom the rest of the wizard
// uses: a spinner over the "waiting for login" period, with onAuth printing
// the URL the user needs to open and onPrompt falling back to a `text`
// prompt for the manual code path. The spinner is started by onAuth and
// stopped by the caller (runInit) — we don't try to manage it here because
// the spinner lifecycle has to span emit('start') -> emit('done').
function buildOAuthCallbacks(providerName: string) {
  return {
    onAuth: (url: string, instructions?: string) => {
      // Don't put the URL inside note(): clack wraps long lines with the box
      // border `│` on each wrapped segment, which corrupts the URL when the
      // user copy-pastes it. Keep instructional text in the box, but print
      // the URL itself as a bare console.log line that any terminal will
      // hyperlink intact.
      const preamble = [`Open this URL in your browser to authorize ${providerName}.`]
      if (instructions) preamble.push('', instructions)
      note(preamble.join('\n'), 'Browser login')
      console.log(url)
      console.log('')
    },
    onProgress: (message: string) => {
      log.info(message)
    },
    onPrompt: async (message: string, placeholder?: string): Promise<string | null> => {
      const value = await text({ message, ...(placeholder !== undefined ? { placeholder } : {}) })
      if (isCancel(value)) return null
      return value
    },
  }
}

function uniqueProviders(options: ModelOption[]): KnownProviderId[] {
  const seen = new Set<KnownProviderId>()
  const out: KnownProviderId[] = []
  for (const o of options) {
    if (seen.has(o.providerId)) continue
    seen.add(o.providerId)
    out.push(o.providerId)
  }
  return out
}

function formatModelHint(o: ModelOption): string {
  const parts: string[] = []
  if (o.contextWindow !== null) parts.push(`${(o.contextWindow / 1000).toFixed(0)}K ctx`)
  if (o.reasoning) parts.push('reasoning')
  return parts.join(' · ')
}

function providerAuthHint(id: KnownProviderId): string {
  const provider = KNOWN_PROVIDERS[id]
  const apiKey = providerSupportsApiKey(provider)
  const oauth = providerSupportsOAuth(provider)
  if (apiKey && oauth) return 'API key or OAuth'
  if (oauth) return 'OAuth login'
  return 'API key'
}

const START_MESSAGES: Record<Exclude<InitStep, 'hatching'>, string> = {
  preflight: 'Checking Docker...',
  'oauth-login': 'Waiting for browser login...',
  scaffold: 'Laying the egg...',
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  install: 'Installing dependencies with bun...',
  dockerfile: 'Writing Dockerfile...',
  git: 'Initializing git repository...',
}
