import { join } from 'node:path'

import { type RuntimeSecretsProvider, resolveRuntimeSecretsProvider } from '@/secrets/secrets-provider'

// The container-stage capability bag: what the agent runtime (`typeclaw run`)
// can CALL to reach durable host-side substrate. Assembled once at the
// container-stage composition root and passed to the modules that need it —
// build at the root, hand specific capabilities down (not a service locator).
//
// `secrets` is nullable: it degrades to null when no write-back backend is
// wired (hostd triple absent, or a managed profile without write-back yet), so
// the runtime boots without crashing. restarter / portForwarder / ingress slot
// in here as they are extracted (see the capability-composition design).
export type RuntimeCapabilities = {
  secrets: RuntimeSecretsProvider | null
}

// Composes the container-stage capabilities. `secretsPath` is the mounted
// secrets.json the runtime reads (defaults to <cwd>/secrets.json, which is
// /agent/secrets.json in the container). Env is injectable for tests. (No
// profile param yet — secrets resolution keys off the env triple; the
// deployment profile enters here when a managed secrets impl selects on it.)
export function createRuntimeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  secretsPath: string = join(process.cwd(), 'secrets.json'),
): RuntimeCapabilities {
  return {
    secrets: resolveRuntimeSecretsProvider(env, secretsPath),
  }
}
