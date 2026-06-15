import { autocomplete, cancel, intro, isCancel, log, password, select } from '@clack/prompts'
import { defineCommand } from 'citty'

import {
  KNOWN_PROVIDER_VENDORS,
  KNOWN_PROVIDERS,
  listKnownProviderVendorIds,
  providerIdsForVendor,
  supportsApiKey as providerSupportsApiKey,
  supportsOAuth as providerSupportsOAuth,
  variantHint,
  variantLabel,
  type KnownProviderId,
  type KnownProviderVendorId,
} from '@/config/providers'
import {
  addProvider,
  listConfiguredProviders,
  removeProvider,
  setProvider,
  type CredentialSource,
} from '@/config/providers-mutation'
import { findAgentDir, isInitialized } from '@/init'
import { makeOAuthLoginRunner } from '@/init/oauth-login'

import { fuzzyMatch } from './fuzzy-filter'
import { buildOAuthCallbacks } from './oauth-callbacks'
import { c, done, errorLine } from './ui'

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'add LLM provider credentials (api key or OAuth) to an existing agent',
  },
  args: {
    provider: {
      type: 'positional',
      description: `provider id (${Object.keys(KNOWN_PROVIDERS).join(' | ')}); omit to pick interactively`,
      required: false,
    },
    key: {
      type: 'string',
      description: 'api key value (non-interactive); incompatible with --oauth',
      required: false,
    },
    env: {
      type: 'string',
      description: 'bind to a custom env-var name (writes { env: NAME } into secrets.json)',
      required: false,
    },
    oauth: {
      type: 'boolean',
      description: 'force OAuth flow (browser login) for providers that support both methods',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const result = await runProviderAddFlow(cwd, args)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
  },
})

export type ProviderAddFlowArgs = {
  provider?: string | undefined
  key?: string | undefined
  env?: string | undefined
  oauth?: boolean | undefined
}

export type ProviderAddFlowResult =
  | { ok: true; providerId: KnownProviderId; method: 'api-key' | 'oauth' }
  | { ok: false; reason: string }

export async function runProviderAddFlow(cwd: string, args: ProviderAddFlowArgs): Promise<ProviderAddFlowResult> {
  const providerId = await resolveProviderForAdd(args.provider)
  const provider = KNOWN_PROVIDERS[providerId]

  intro(`Adding provider: ${provider.name}`)

  const method = await resolveAuthMethod(provider, args)
  if (method === 'oauth') {
    const result = await runOAuthLogin(cwd, providerId)
    if (!result.ok) return { ok: false, reason: `OAuth login failed: ${result.reason}` }
    done({
      title: c.green(`Logged in to ${provider.name}.`),
      hints: nextStepHints({ credentialChanged: true }),
    })
    return { ok: true, providerId, method: 'oauth' }
  }

  const credential = await resolveApiKeyInputs(provider, args)
  const result = addProvider(cwd, providerId, credential)
  if (!result.ok) return { ok: false, reason: result.reason }
  done({
    title: c.green(`Added ${provider.name} credentials to secrets.json.`),
    hints: nextStepHints({ credentialChanged: true }),
  })
  return { ok: true, providerId, method: 'api-key' }
}

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'rotate/update credentials for an already-configured provider',
  },
  args: {
    provider: {
      type: 'positional',
      description: `provider id (${Object.keys(KNOWN_PROVIDERS).join(' | ')})`,
      required: true,
    },
    key: {
      type: 'string',
      description: 'new api key value (non-interactive); incompatible with --oauth',
      required: false,
    },
    env: {
      type: 'string',
      description: 'bind to a custom env-var name (writes { env: NAME } into secrets.json)',
      required: false,
    },
    oauth: {
      type: 'boolean',
      description: 're-run OAuth flow (browser login)',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const providerId = validateKnownProvider(args.provider)
    const provider = KNOWN_PROVIDERS[providerId]

    intro(`Updating provider: ${provider.name}`)

    const method = await resolveAuthMethod(provider, args)
    if (method === 'oauth') {
      const result = await runOAuthLogin(cwd, providerId)
      if (!result.ok) {
        console.error(errorLine(`OAuth login failed: ${result.reason}`))
        process.exit(1)
      }
      done({
        title: c.green(`Refreshed OAuth credentials for ${provider.name}.`),
        hints: nextStepHints({ credentialChanged: true }),
      })
      return
    }

    const credential = await resolveApiKeyInputs(provider, args)
    const result = setProvider(cwd, providerId, credential)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Updated ${provider.name} credentials in secrets.json.`),
      hints: nextStepHints({ credentialChanged: true }),
    })
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a provider entry from secrets.json (refuses when a model profile references it)',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'provider id to remove',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'remove even when a model profile references this provider',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const providerId = args.provider
    const provider = providerId in KNOWN_PROVIDERS ? KNOWN_PROVIDERS[providerId as KnownProviderId] : null
    const label = provider?.name ?? providerId

    intro(`Removing provider: ${label}`)

    const result = removeProvider(cwd, providerId, { force: args.force === true })
    if (!result.ok) {
      const list = result.profiles.join(', ')
      console.error(
        errorLine(
          `Cannot remove "${providerId}": referenced by model profile(s) [${list}]. Update those profiles first, or rerun with --force.`,
        ),
      )
      process.exit(1)
    }
    if (!result.existed) {
      log.info(`No "${providerId}" entry in secrets.json — nothing to remove.`)
    }
    done({
      title: c.green(`Removed ${label} from secrets.json.`),
      hints: nextStepHints({ credentialChanged: true }),
    })
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'show configured providers and how each credential resolves (file / env / oauth)',
  },
  async run() {
    const cwd = ensureAgentDir()
    const entries = listConfiguredProviders(cwd)
    if (entries.length === 0) {
      console.log(c.dim('No providers configured. Run `typeclaw provider add <id>` to wire one up.'))
      return
    }

    const rows = entries.map((entry) => {
      const refs =
        entry.referencedByProfiles.length === 0 ? c.dim('(no profile)') : entry.referencedByProfiles.join(',')
      const name = entry.id in KNOWN_PROVIDERS ? KNOWN_PROVIDERS[entry.id as KnownProviderId].name : entry.id
      return {
        id: entry.id,
        name,
        type: entry.type,
        source: describeSource(entry.source),
        refs,
      }
    })

    const idWidth = Math.max(2, ...rows.map((r) => r.id.length))
    const typeWidth = Math.max(4, ...rows.map((r) => r.type.length))
    const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length))

    const header = `${'ID'.padEnd(idWidth)}  ${'TYPE'.padEnd(typeWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  PROFILES`
    console.log(c.dim(header))
    for (const r of rows) {
      const line = `${r.id.padEnd(idWidth)}  ${r.type.padEnd(typeWidth)}  ${r.source.padEnd(sourceWidth)}  ${r.refs}  ${c.dim(`(${r.name})`)}`
      console.log(line)
    }
  },
})

export const providerCommand = defineCommand({
  meta: {
    name: 'provider',
    description: 'manage LLM provider credentials in secrets.json',
  },
  subCommands: {
    add: addSub,
    set: setSub,
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

function validateKnownProvider(input: string): KnownProviderId {
  if (input in KNOWN_PROVIDERS) return input as KnownProviderId
  console.error(errorLine(`Unknown provider "${input}". Available: ${Object.keys(KNOWN_PROVIDERS).join(', ')}.`))
  process.exit(1)
}

async function resolveProviderForAdd(input: string | undefined): Promise<KnownProviderId> {
  if (input !== undefined) return validateKnownProvider(input)
  const vendorId = await pickVendorToAdd()
  return await pickVariantToAdd(vendorId)
}

async function pickVendorToAdd(): Promise<KnownProviderVendorId> {
  const vendorIds = listKnownProviderVendorIds()
  const choice = await autocomplete<KnownProviderVendorId>({
    message: 'Pick a provider to add',
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: vendorIds.map((id) => ({
      value: id,
      label: KNOWN_PROVIDER_VENDORS[id].name,
      hint: vendorAuthHint(id),
    })),
    initialValue: vendorIds[0],
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

async function pickVariantToAdd(vendorId: KnownProviderVendorId): Promise<KnownProviderId> {
  const variants = providerIdsForVendor(vendorId)
  if (variants.length === 1) return variants[0]!
  const choice = await autocomplete<KnownProviderId>({
    message: `Pick a ${KNOWN_PROVIDER_VENDORS[vendorId].name} option`,
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: variants.map((id) => {
      const hint = variantHint(vendorId, id)
      return hint !== undefined
        ? { value: id, label: variantLabel(vendorId, id), hint }
        : { value: id, label: variantLabel(vendorId, id) }
    }),
    initialValue: variants[0],
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

type AuthArgs = { oauth?: boolean | undefined; key?: string | undefined; env?: string | undefined }

async function resolveAuthMethod(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  args: AuthArgs,
): Promise<'api-key' | 'oauth'> {
  const apiKeyOk = providerSupportsApiKey(provider)
  const oauthOk = providerSupportsOAuth(provider)
  if (args.oauth === true) {
    if (!oauthOk) {
      console.error(errorLine(`Provider ${provider.name} does not support OAuth.`))
      process.exit(1)
    }
    return 'oauth'
  }
  if (args.key !== undefined || args.env !== undefined) {
    if (!apiKeyOk) {
      console.error(errorLine(`Provider ${provider.name} does not support api-key auth. Re-run with --oauth instead.`))
      process.exit(1)
    }
    return 'api-key'
  }
  if (apiKeyOk && oauthOk) {
    const choice = await select<'api-key' | 'oauth'>({
      message: `How do you want to authenticate to ${provider.name}?`,
      options: [
        { value: 'api-key', label: 'API key', hint: 'saved to secrets.json' },
        { value: 'oauth', label: 'OAuth (browser login)', hint: 'saved to secrets.json' },
      ],
      initialValue: 'api-key',
    })
    if (isCancel(choice)) {
      cancel('Aborted.')
      process.exit(0)
    }
    return choice
  }
  return oauthOk ? 'oauth' : 'api-key'
}

async function resolveApiKeyInputs(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  args: AuthArgs,
): Promise<
  { type: 'api_key'; key: string; envBinding?: string | undefined } | { type: 'env-binding'; envBinding: string }
> {
  if (args.env !== undefined && args.key === undefined) {
    return { type: 'env-binding', envBinding: args.env }
  }
  if (args.key !== undefined) {
    const result: { type: 'api_key'; key: string; envBinding?: string } = { type: 'api_key', key: args.key }
    if (args.env !== undefined) result.envBinding = args.env
    return result
  }
  return { type: 'api_key', key: await promptApiKey(provider) }
}

async function promptApiKey(provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]): Promise<string> {
  const value = await password({
    message: `Put your ${provider.name} API key (will be saved to secrets.json)`,
    validate: (v) => (v && v.length > 0 ? undefined : 'API key is required'),
  })
  if (isCancel(value)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return value
}

async function runOAuthLogin(cwd: string, providerId: KnownProviderId): Promise<{ ok: boolean; reason?: string }> {
  const provider = KNOWN_PROVIDERS[providerId]
  // Pick any model ref for the provider; OAuth login only uses the ref to
  // discover the provider's `oauthProviderId`, which is the same regardless
  // of which model the user later selects via `typeclaw model set`.
  const ref = Object.keys(provider.models)[0]
  if (ref === undefined) {
    return { ok: false, reason: `Provider ${provider.name} has no registered models.` }
  }
  const modelRef = `${providerId}/${ref}` as const

  const { callbacks, dispose } = buildOAuthCallbacks(provider.name)
  try {
    const runner = makeOAuthLoginRunner(callbacks)
    const result = await runner({ cwd, model: modelRef as Parameters<typeof runner>[0]['model'] })
    if (!result.ok) return { ok: false, reason: result.reason }
    return { ok: true }
  } finally {
    dispose()
  }
}

function vendorAuthHint(vendorId: KnownProviderVendorId): string {
  const providers = providerIdsForVendor(vendorId)
  const apiKey = providers.some((id) => providerSupportsApiKey(KNOWN_PROVIDERS[id]))
  const oauth = providers.some((id) => providerSupportsOAuth(KNOWN_PROVIDERS[id]))
  if (apiKey && oauth) return 'API key or OAuth'
  if (oauth) return 'OAuth only'
  return 'API key'
}

function describeSource(source: CredentialSource): string {
  switch (source.kind) {
    case 'file':
      return 'file'
    case 'env-only':
      return `env (${source.envName})`
    case 'env-overridden':
      return `env (${source.envName}, overrides file)`
    case 'oauth':
      return 'oauth'
  }
}

function nextStepHints(opts: { credentialChanged: boolean }): { label: string; command: string }[] {
  if (!opts.credentialChanged) return []
  return [{ label: 'If the agent is running:', command: 'typeclaw reload' }]
}
