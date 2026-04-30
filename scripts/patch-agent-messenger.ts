#!/usr/bin/env bun

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

type Patch = { file: string; find: string; replace: string }

const PATCHES: Patch[] = [
  {
    file: 'node_modules/agent-messenger/src/platforms/discordbot/client.ts',
    find: `    if (!message.attachments || message.attachments.length === 0) {
      throw new DiscordBotError('Upload succeeded but no attachments returned', 'no_attachments')
    }

    return message.attachments[0]
  }`,
    replace: `    const first = message.attachments?.[0]
    if (!first) {
      throw new DiscordBotError('Upload succeeded but no attachments returned', 'no_attachments')
    }

    return first
  }`,
  },
  // agent-messenger ships a `./slackbot` entry under `typesVersions` and the
  // README documents the import path, but the package's `exports` map omits
  // it. Without an `exports` entry, Bun + tsgo refuse to resolve
  // `agent-messenger/slackbot`. Inject the entry to match every other
  // platform.
  {
    file: 'node_modules/agent-messenger/package.json',
    find: `    "./discordbot": {
      "types": "./src/platforms/discordbot/index.ts",
      "default": "./src/platforms/discordbot/index.ts"
    },`,
    replace: `    "./discordbot": {
      "types": "./src/platforms/discordbot/index.ts",
      "default": "./src/platforms/discordbot/index.ts"
    },
    "./slackbot": {
      "types": "./src/platforms/slackbot/index.ts",
      "default": "./src/platforms/slackbot/index.ts"
    },`,
  },
  // The slackbot credential-manager has multiple `noUncheckedIndexedAccess`
  // strict-mode violations that surface through tsgo (skipLibCheck only
  // applies to .d.ts, and agent-messenger ships .ts source). Suppress them
  // wholesale with @ts-nocheck — we don't use this class from typeclaw, and
  // patching every call site individually would be brittle.
  {
    file: 'node_modules/agent-messenger/src/platforms/slackbot/credential-manager.ts',
    find: `import { existsSync } from 'node:fs'`,
    replace: `// @ts-nocheck
import { existsSync } from 'node:fs'`,
  },
]

let applied = 0
let skipped = 0

for (const patch of PATCHES) {
  const path = join(repoRoot, patch.file)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    console.warn(`[patch-agent-messenger] ${patch.file} not found; skipping`)
    skipped++
    continue
  }
  if (content.includes(patch.replace)) {
    skipped++
    continue
  }
  if (!content.includes(patch.find)) {
    console.warn(`[patch-agent-messenger] ${patch.file} did not match expected source; skipping`)
    skipped++
    continue
  }
  await writeFile(path, content.replace(patch.find, patch.replace), 'utf8')
  applied++
}

console.log(`[patch-agent-messenger] applied=${applied} skipped=${skipped}`)
