import { z } from 'zod'

// A Secret is the on-disk shape for any env-injectable credential field.
// String shorthand is sugar for `{ value }`. The schema normalises to the
// object form at parse time so consumers only ever handle one shape, but
// writers MAY emit the string shorthand for the common no-custom-env case
// to keep `secrets.json` terse.
//
// Empty objects `{}` are rejected because they carry no information — the
// resolver would always return undefined for them and the file would silently
// fail to provide credentials at boot.
const secretObjectSchema = z
  .object({
    value: z.string().min(1).optional(),
    env: z.string().min(1).optional(),
  })
  .refine((s) => s.value !== undefined || s.env !== undefined, {
    message: 'Secret object must have at least one of `value` or `env`',
  })

export const secretFieldSchema = z
  .union([z.string().min(1), secretObjectSchema])
  .transform((v) => (typeof v === 'string' ? { value: v } : v))

export type Secret = z.infer<typeof secretFieldSchema>

// Env-wins resolution. The single place env-vs-file precedence lives.
//
// Precedence (highest to lowest):
//   1. process.env[secret.env]    — explicit binding wins
//   2. process.env[defaultEnv]    — canonical env-var-name fallback
//   3. secret.value               — on-disk value
//   4. undefined                  — caller decides (missing-credential error)
//
// Empty-string env values are treated as unset, matching the existing
// hydrate.ts policy (`env[key] !== '' `). This keeps `unset` and `set to ""`
// behaviorally identical for credentials, which is what every shell ecosystem
// converges on.
export function resolveSecret(
  secret: Secret,
  defaultEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const envName = secret.env ?? defaultEnv
  if (envName !== undefined) {
    const fromEnv = env[envName]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  }
  return secret.value
}

// Returns the env-var name that resolveSecret would consult for a given
// Secret + default. Used by doctor / diagnostics to report "if you want to
// override this, set $envName". Does NOT consult process.env — pure mapping.
export function effectiveEnvName(secret: Secret, defaultEnv: string | undefined): string | undefined {
  return secret.env ?? defaultEnv
}
