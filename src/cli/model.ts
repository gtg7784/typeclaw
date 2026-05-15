import { cancel, intro, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'

import { addProfile, listModelProfiles, removeProfile, setProfile } from '@/config/models-mutation'
import {
  KNOWN_PROVIDERS,
  listKnownModelRefs,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import { findAgentDir, isInitialized } from '@/init'

import { c, done, errorLine } from './ui'

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'set or update a model profile (default | fast | vision | <custom>)',
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
    const ref = args.ref ?? (await pickModelRef())

    intro(`Setting model profile: ${profile} → ${ref}`)

    const result = setProfile(cwd, profile, ref, { force: args.force === true })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${profile}" set to ${ref}.`),
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
    const ref = args.ref ?? (await pickModelRef())

    intro(`Adding model profile: ${args.profile} → ${ref}`)

    const result = addProfile(cwd, args.profile, ref, { force: args.force === true })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${args.profile}" → ${ref}.`),
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
      printAvailableRefs()
      return
    }
    const cwd = ensureAgentDir()
    const entries = listModelProfiles(cwd)
    if (entries.length === 0) {
      console.log(c.dim('No models configured.'))
      return
    }

    const profileWidth = Math.max(7, ...entries.map((e) => e.profile.length))
    const refWidth = Math.max(3, ...entries.map((e) => e.ref.length))

    const header = `${'PROFILE'.padEnd(profileWidth)}  ${'REF'.padEnd(refWidth)}  PROVIDER  STATUS`
    console.log(c.dim(header))
    for (const e of entries) {
      const star = e.isDefault ? c.cyan('*') : ' '
      const status = e.credentialStatus === 'available' ? c.green('ok') : c.yellow('missing-credentials')
      const line = `${star}${e.profile.padEnd(profileWidth - 1)}  ${e.ref.padEnd(refWidth)}  ${e.providerId.padEnd(12)}  ${status}`
      console.log(line)
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

async function pickModelRef(): Promise<string> {
  const refs = listKnownModelRefs()
  const choice = await select<KnownModelRef>({
    message: 'Pick a model',
    options: refs.map((ref) => ({
      value: ref,
      label: describeRef(ref),
      hint: ref,
    })),
    initialValue: refs[0],
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

function describeRef(ref: KnownModelRef): string {
  const providerId = providerForModelRef(ref)
  const modelId = ref.slice(providerId.length + 1)
  const provider = KNOWN_PROVIDERS[providerId]
  const model = (provider.models as Record<string, { name: string }>)[modelId]
  return model ? `${provider.name} · ${model.name}` : ref
}

function printAvailableRefs(): void {
  const refs = listKnownModelRefs()
  if (refs.length === 0) {
    console.log(c.dim('No models registered.'))
    return
  }
  console.log(c.dim('Use `typeclaw model set <profile> <ref>` to apply.'))
  let lastProvider: KnownProviderId | null = null
  for (const ref of refs) {
    const providerId = providerForModelRef(ref)
    if (providerId !== lastProvider) {
      console.log('')
      console.log(c.cyan(KNOWN_PROVIDERS[providerId].name))
      lastProvider = providerId
    }
    console.log(`  ${ref}`)
  }
}
