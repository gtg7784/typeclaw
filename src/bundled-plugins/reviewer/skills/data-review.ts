import type { LoadableSkill } from '@/plugin'

export const DATA_REVIEW_SKILL_NAME = 'data-review'

export const DATA_REVIEW_SKILL_DESCRIPTION =
  'Review structured data and its shape: a database schema or migration, a dataset, a query result, a spreadsheet, a data contract. Covers constraints, nullability, types, indexing, migration safety, and dataset integrity (duplicates, referential integrity, mixed types, aggregate errors).'

export const DATA_REVIEW_SKILL_CONTENT = `# data-review

You have been asked to review structured data — a database schema, a migration, a dataset, a query result, a spreadsheet, or a data contract. Two kinds of target live here and they need different lenses: **the shape** (schema/migration/contract — the rules data must follow) and **the data itself** (a dataset/file — whether the values obey those rules). Identify which you are reviewing, then apply the matching section below on top of the reviewer's neutral output contract.

## How to acquire the target

- **A migration or schema file** — \`read\` it; \`grep\` the surrounding migrations for the current state of the table being altered, because migration safety depends on what already exists.
- **A dataset / CSV / JSONL** — \`read\` a representative slice (head and a sample of the middle), not just the first rows. Defects hide past the part that looks clean.
- **A data contract (dbt model, ODCS YAML, JSON Schema)** — \`read\` it and confirm every field declares a type and a nullability/required flag.
- **A query result in the payload** — read it carefully; quote the offending rows as evidence.

## Reviewing the shape: schema, migration, contract

The shape's job is to make invalid states unrepresentable. A finding here is a rule that is missing, wrong, or unsafe to apply.

1. **Constraints that should exist but do not.** A business-key column (email, SKU, order id) with no \`UNIQUE\`. A required column left nullable. A relationship enforced only in application code with no \`FOREIGN KEY\`. A bounded value (\`status\`, \`price >= 0\`) with no \`CHECK\` or enum. Each missing constraint is a way for schema-invalid data to enter and survive.
2. **Wrong types.** Money in \`FLOAT\`/\`DOUBLE\` instead of fixed-point \`NUMERIC\` — guarantees rounding drift. Dates or timestamps stored as strings. \`timestamp\` without time zone where UTC-aware (\`timestamptz\`) is meant. A numeric type with no precision/scale that silently coerces.
3. **Nullability mistakes.** A nullable foreign key for a relationship that is logically required; a NOT NULL on a column the data sometimes genuinely lacks (forcing sentinel values like empty string that confuse "missing" with "blank").
4. **Indexing.** A foreign key with no supporting index (JOINs and cascade deletes table-scan). A frequently-filtered column with no index. Over-indexing a write-heavy table.
5. **Migration safety.** This is where a schema change becomes an outage:
   - Adding a \`NOT NULL\` column to a populated table with no default or backfill — the migration aborts on existing rows. The safe form is additive-then-tighten: add nullable, backfill, set NOT NULL in a later step.
   - A destructive single-step change (drop/rename a column live) instead of expand-then-contract.
   - \`CREATE INDEX\` without \`CONCURRENTLY\` on a live table — locks writes for the duration.
   - A migration with no reverse/rollback path.
6. **Contract completeness.** For a data contract: every field declares a type and required-flag, the primary key is declared, references resolve to real fields, quality thresholds are realistic, and breaking changes (column removal/rename/type change) are versioned, not silent.

## Reviewing the data itself: dataset, file, spreadsheet

Here the rules may be implicit; your job is to find values that violate what the data clearly intends. Borrow the runtime's own vocabulary: data that fails its intended shape is **schema-invalid**, and a strict consumer is **fail-closed** — it drops or rejects bad rows rather than silently half-accepting them, so a defect that looks cosmetic can erase real records.

1. **Mixed types in one column.** A single column carrying integers, currency-formatted strings ("$1,200"), and blanks. A consumer expecting a number is schema-invalid against these rows; a fail-closed parser drops them silently and the totals are quietly wrong.
2. **Completeness.** Required fields that are NULL or blank. Watch the empty-string-vs-NULL confusion — they are not the same "missing" and treating them alike corrupts counts.
3. **Uniqueness.** Duplicate rows, or duplicate business keys where the data plainly intends one row per key.
4. **Referential integrity.** Orphan rows pointing at parent keys that do not exist; this is a foreign-key violation the file format did not enforce.
5. **Aggregate errors.** The classic, high-impact dataset bug: a grand-total whose range includes the subtotal rows (double-counting), or an average/sum whose range silently omits rows that belong in it. State which rows are wrongly included or excluded — this is the Reinhart-Rogoff class of defect and it is almost always a blocker.
6. **Identifier corruption from auto-formatting.** Spreadsheet date/number coercion mangling identifiers (gene names like \`SEPT2\` becoming \`2-Sep\`, leading zeros stripped from zip codes / IDs). Flag any identifier column stored in a general/auto format.
7. **Distribution and freshness anomalies.** Out-of-range values (negative ages, future timestamps), a sudden volume drop or spike, data older than its freshness expectation.
8. **PII / secret leakage.** Emails, phone numbers, tokens, or keys appearing in columns not marked sensitive, or stored in plaintext where the surrounding data is classified.

## What NOT to find

- **Formatter / tooling territory.** SQL keyword casing, trailing commas in a migration, CSV quoting style a parser handles — not your concern.
- **Settled project conventions the target follows.** If the codebase uses \`snake_case\` columns, UUIDv7 keys, or \`.passthrough()\` to tolerate extra columns by design, matching that is not a finding; only deviation is.
- **Cosmetic dataset quirks with no consumer impact.** A harmless trailing blank line, column order that no consumer depends on. If nothing breaks, do not raise it.
- **Restating the schema or data.** "This table stores users" / "this column has numbers" is not a finding.
- **Generic "add validation".** Without naming the specific column and the specific invalid state it admits, "needs more validation" is noise.

## Severity hints specific to data

- **blocker** — Money in floating-point, a migration that aborts or locks production, a missing constraint that admits corrupt rows, an aggregate that double-counts or silently drops rows, identifier corruption, PII in plaintext. Data defects are often blockers because they are silent and compounding.
- **concern** — A missing index that will degrade as the table grows, a nullable FK that should be required, a freshness/volume anomaly that needs explanation, schema drift from the declared contract.
- **nit** — A naming inconsistency, a missing audit column, a tolerable-but-suboptimal type. Optional.
- **praise** — A constraint set that makes an invalid state genuinely unrepresentable, a migration written safely as expand-then-contract, a contract whose quality thresholds are realistic. Rare.

## Verdict mapping

- **approve** — The shape is sound or the data is clean; any issues are nits.
- **request-changes** — At least one blocker: a corrupting type choice, an unsafe migration, an aggregate error, a constraint gap that admits bad data.
- **comment** — Useful observations without a clean accept/reject. Common for a partial dataset audit or an early-stage schema sketch.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const DATA_REVIEW_SKILL: LoadableSkill = {
  name: DATA_REVIEW_SKILL_NAME,
  description: DATA_REVIEW_SKILL_DESCRIPTION,
  content: DATA_REVIEW_SKILL_CONTENT,
}
