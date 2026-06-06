import { MIGRATION_ID, migrateSecretsV1ToV2, type SecretsMigrationResult } from './secrets-v1-to-v2'

export { MIGRATION_ID, migrateSecretsV1ToV2, type SecretsMigrationResult }

export type Migration = {
  id: string
  run: (agentDir: string) => SecretsMigrationResult
}

export type MigrationOutcome = { id: string; changed: boolean; summary: string; error?: string }

const MIGRATIONS: readonly Migration[] = [{ id: MIGRATION_ID, run: migrateSecretsV1ToV2 }]

// Each migration is isolated: a throw is captured per-migration so one folder's
// unsafe state (e.g. both auth.json and a non-empty secrets.json) is reported
// loudly without aborting boot or blocking later migrations. Returns one
// outcome per registered migration so the caller can log what happened.
export function runStartupMigrations(
  agentDir: string,
  log: (message: string) => void = (m) => console.warn(m),
): MigrationOutcome[] {
  const outcomes: MigrationOutcome[] = []
  for (const migration of MIGRATIONS) {
    try {
      const result = migration.run(agentDir)
      if (result.changed) log(`migration ${migration.id}: ${result.summary}`)
      outcomes.push({ id: migration.id, changed: result.changed, summary: result.summary })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log(`migration ${migration.id} failed: ${error}`)
      outcomes.push({ id: migration.id, changed: false, summary: 'failed', error })
    }
  }
  return outcomes
}
