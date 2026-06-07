import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The docs site builds with turbopack.root pinned to docs/, so page code cannot
// import the repo-root package.json directly. This prebuild step copies the root
// version into a generated module the landing page reads, keeping the badge in
// sync with every release without a manual edit.
const rootPackageJson = path.resolve(import.meta.dirname, '../../package.json')
const outFile = path.resolve(import.meta.dirname, '../src/generated/version.ts')

const { version } = (await import(rootPackageJson, { with: { type: 'json' } })).default as {
  version: string
}

mkdirSync(path.dirname(outFile), { recursive: true })
writeFileSync(outFile, `export const TYPECLAW_VERSION = '${version}'\n`)
