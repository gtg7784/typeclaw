import { cancel, intro, isCancel, log, select } from '@clack/prompts'
import { defineCommand } from 'citty'

import type { CustomModelMeta } from '@/config'
import {
  addProfile,
  listModelProfiles,
  listRegisteredModelRefs,
  removeProfile,
  setProfile,
} from '@/config/models-mutation'
import {
  isKnownModelRef,
  KNOWN_PROVIDERS,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import { findAgentDir, isInitialized } from '@/init'
import { customModelMetaFromOption, fetchModelOptions, type ModelOption } from '@/init/models-dev'

import { runProviderAddFlow } from './provider'
import { c, done, errorLine } from './ui'

const ADD_PROVIDER_SENTINEL = '__add-provider__'

type PickedModelRef = {
  ref: string
  meta?: CustomModelMeta
}

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'set or update a model profile (default | fast | deep | vision | <custom>)',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name (typically `default`); omit to pick interactively',
      required: false,
    },
    ref: {
      type: 'positional',
      description: '<provider>/<model> ref; omit to pick interactively',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'write even when the target provider has no credentials configured',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const profile = args.profile ?? (await pickProfileName())
    const picked = args.ref !== undefined ? await resolveExplicitRef(args.ref) : await pickModelRef(cwd)

    intro(`Setting model profile: ${profile} → ${picked.ref}`)

    const result = setProfile(cwd, profile, picked.ref, {
      force: args.force === true,
      ...(picked.meta !== undefined ? { meta: picked.meta } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${profile}" set.`),
      details: `${profile} → ${picked.ref}`,
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'create a new (non-default) model profile; refuses when the profile already exists',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name (must not already exist)',
      required: true,
    },
    ref: {
      type: 'positional',
      description: '<provider>/<model> ref; omit to pick interactively',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'write even when the target provider has no credentials configured',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const picked = args.ref !== undefined ? await resolveExplicitRef(args.ref) : await pickModelRef(cwd)

    intro(`Adding model profile: ${args.profile} → ${picked.ref}`)

    const result = addProfile(cwd, args.profile, picked.ref, {
      force: args.force === true,
      ...(picked.meta !== undefined ? { meta: picked.meta } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${args.profile}" added.`),
      details: `${args.profile} → ${picked.ref}`,
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a non-default model profile (cannot remove `default`)',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name to remove',
      required: true,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    intro(`Removing model profile: ${args.profile}`)
    const result = removeProfile(cwd, args.profile)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${args.profile}" removed.`),
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list configured model profiles (or all known model refs with --available)',
  },
  args: {
    available: {
      type: 'boolean',
      description: 'list every <provider>/<model> ref typeclaw recognizes (not just configured profiles)',
      required: false,
    },
  },
  async run({ args }) {
    if (args.available === true) {
      await printAvailableRefs()
      return
    }
    const cwd = ensureAgentDir()
    const entries = listModelProfiles(cwd)
    if (entries.length === 0) {
      console.log(c.dim('No models configured.'))
      return
    }

    const profileWidth = Math.max(7, ...entries.map((e) => e.profile.length))
    const refDisplay = (e: (typeof entries)[number]): string =>
      e.refs.length > 1 ? `${e.ref} ${c.dim(`(+${e.refs.length - 1} fallback)`)}` : e.ref
    const refWidth = Math.max(3, ...entries.map((e) => e.ref.length + (e.refs.length > 1 ? 14 : 0)))

    const header = `${'PROFILE'.padEnd(profileWidth)}  ${'REF'.padEnd(refWidth)}  PROVIDER  STATUS`
    console.log(c.dim(header))
    for (const e of entries) {
      const star = e.isDefault ? c.cyan('*') : ' '
      const status = e.credentialStatus === 'available' ? c.green('ok') : c.yellow('missing-credentials')
      const line = `${star}${e.profile.padEnd(profileWidth - 1)}  ${refDisplay(e).padEnd(refWidth)}  ${e.providerId.padEnd(12)}  ${status}`
      console.log(line)
      if (e.refs.length > 1) {
        for (let i = 1; i < e.refs.length; i++) {
          const fb = e.refs[i]!
          console.log(`${' '.padEnd(profileWidth + 2)}↳ ${c.dim(fb)}`)
        }
      }
    }
  },
})

export const modelCommand = defineCommand({
  meta: {
    name: 'model',
    description: 'manage model profiles in typeclaw.json (models.default, models.fast, …)',
  },
  subCommands: {
    set: setSub,
    add: addSub,
    remove: removeSub,
    list: listSub,
  },
})

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

async function pickProfileName(): Promise<string> {
  const choice = await select<string>({
    message: 'Pick a profile to set',
    options: [
      { value: 'default', label: 'default', hint: 'active model for new sessions' },
      { value: 'fast', label: 'fast', hint: 'optional alias used by some subagents' },
      { value: 'deep', label: 'deep', hint: 'optional alias used by some subagents' },
      { value: 'vision', label: 'vision', hint: 'optional alias used by some subagents' },
    ],
    initialValue: 'default',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

async function pickModelRef(cwd: string): Promise<PickedModelRef> {
  while (true) {
    const refs = listRegisteredModelRefs(cwd)
    if (refs.length === 0) {
      log.info("No provider credentials found. Let's add one first.")
      const added = await runProviderAddFlow(cwd, {})
      if (!added.ok) {
        console.error(errorLine(added.reason))
        process.exit(1)
      }
      continue
    }
    // select<string>, not the KnownModelRef union: clack's Option<Value> is a
    // distributive conditional type and a large ref union breaks `value: ref`
    // assignability. Values are ref strings (+ the sentinel) and stay correct
    // at runtime — the sentinel check and `return choice` below are unaffected.
    const modelOptions = await listCredentialedModelOptions(refs)
    const choice = await select<string>({
      message: 'Pick a model',
      options: [
        ...modelOptions.map((option) => ({
          value: option.ref,
          label: describeRef(option.ref),
          hint: option.ref,
        })),
        {
          value: ADD_PROVIDER_SENTINEL,
          label: c.cyan('+ add provider'),
          hint: 'configure a new provider',
        },
      ],
      initialValue: modelOptions[0]?.ref ?? refs[0],
    })
    if (isCancel(choice)) {
      cancel('Aborted.')
      process.exit(0)
    }
    if (choice !== ADD_PROVIDER_SENTINEL) {
      const option = modelOptions.find((candidate) => candidate.ref === choice)
      if (option === undefined) return { ref: choice }
      const meta = customModelMetaFromOption(option)
      return { ref: option.ref, ...(meta !== undefined ? { meta } : {}) }
    }
    const added = await runProviderAddFlow(cwd, {})
    if (!added.ok) {
      console.error(errorLine(added.reason))
      process.exit(1)
    }
  }
}

// Non-interactive `<ref>` path. Curated refs resolve from KNOWN_PROVIDERS, so
// they need no metadata. Non-curated refs are looked up in the live catalog so
// `customModels[ref]` carries the same metadata the interactive picker would
// persist; without it `resolveModel` silently falls back to defaults. A
// catalog miss (offline / unknown id) still writes the ref, but warns first.
export async function resolveExplicitRef(
  ref: string,
  loadCatalog: () => Promise<{ options: ModelOption[] }> = fetchModelOptions,
): Promise<PickedModelRef> {
  if (isKnownModelRef(ref)) return { ref }
  const { options } = await loadCatalog()
  const option = options.find((candidate) => candidate.ref === ref)
  if (option === undefined) {
    log.warn(
      `"${ref}" isn't in the live catalog; saving the ref without metadata. ` +
        `The agent will use fallback defaults (reasoning off, text-only input, zero cost, provider-default context).`,
    )
    return { ref }
  }
  const meta = customModelMetaFromOption(option)
  return { ref, ...(meta !== undefined ? { meta } : {}) }
}

export type { PickedModelRef }

async function listCredentialedModelOptions(refs: KnownModelRef[]): Promise<ModelOption[]> {
  const credentialedProviders = new Set<KnownProviderId>(refs.map((ref) => providerForModelRef(ref)))
  const catalog = await fetchModelOptions()
  const options = catalog.options.filter((option) => credentialedProviders.has(option.providerId))
  if (options.length > 0) return options
  return refs.map((ref) => {
    const providerId = providerForModelRef(ref)
    const modelId = ref.slice(providerId.length + 1)
    const model = (
      KNOWN_PROVIDERS[providerId].models as Record<
        string,
        { name: string; reasoning?: boolean; contextWindow?: number; input?: ReadonlyArray<string> }
      >
    )[modelId]
    return {
      ref,
      providerId,
      providerName: KNOWN_PROVIDERS[providerId].name,
      modelId,
      modelName: model?.name ?? modelId,
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow ?? null,
      curated: true,
      supportsVision: model?.input?.includes('image') ?? false,
    }
  })
}

function describeRef(ref: string): string {
  try {
    const providerId = providerForModelRef(ref)
    const modelId = ref.slice(providerId.length + 1)
    const provider = KNOWN_PROVIDERS[providerId]
    const model = (provider.models as Record<string, { name: string }>)[modelId]
    return `${provider.name} · ${model?.name ?? modelId}`
  } catch {
    return ref
  }
}

async function printAvailableRefs(): Promise<void> {
  const { options, source, warning } = await fetchModelOptions()
  if (options.length === 0) {
    console.log(c.dim('No models registered.'))
    return
  }
  console.log(c.dim('Use `typeclaw model set <profile> <ref>` to apply.'))
  if (source === 'curated' && warning !== undefined) {
    console.log(c.dim(`Using built-in catalog (models.dev unavailable: ${warning}).`))
  }
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const providerOptions = options.filter((option) => option.providerId === providerId)
    if (providerOptions.length === 0) continue
    console.log('')
    console.log(c.cyan(KNOWN_PROVIDERS[providerId].name))
    for (const option of providerOptions) {
      console.log(`  ${option.ref}`)
    }
  }
}
