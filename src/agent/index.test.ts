import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import { createHookBus, type PluginRegistry } from '@/plugin'
import { createStream } from '@/stream'

import {
  buildChannelTools,
  createOverrideResourceLoader,
  createResourceLoader,
  formatRestartNotice,
  getBundledSkillsDir,
  subscribeRestartNotice,
} from './index'
import type { SessionOrigin } from './session-origin'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt'

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['init', '-q', '-b', 'main'])
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('createResourceLoader', () => {
  test('starts the system prompt with the typeclaw default instead of pi default', async () => {
    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    // Pi's DefaultResourceLoader auto-appends ~/.pi/agent/APPEND_SYSTEM.md and
    // .pi/APPEND_SYSTEM.md. Typeclaw owns the whole system prompt, so nothing
    // from pi's discovery should leak in.

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })

  test('injects IDENTITY.md and SOUL.md contents into the system prompt', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), 'I am Tester.')
    await writeFile(join(agentDir, 'SOUL.md'), 'Pedantic and kind.')

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('I am Tester.')
    expect(prompt).toContain('Pedantic and kind.')
  })

  test('signals missing identity files so the model can see they should exist', async () => {
    // when (no files written)
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('[MISSING]')
    expect(prompt).toContain('IDENTITY.md')
    expect(prompt).toContain('SOUL.md')
  })

  test('does NOT inject MEMORY.md or memory/ stream contents (owned by the bundled memory plugin via session.prompt hook)', async () => {
    await writeFile(join(agentDir, 'MEMORY.md'), 'Neo prefers terse replies.')
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'tuesday-fragment-marker')

    const loader = await createResourceLoader({ agentDir })

    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('Neo prefers terse replies.')
    expect(prompt).not.toContain('tuesday-fragment-marker')
    expect(prompt).not.toContain('## memory/2026-04-27.md')
  })

  test('exposes the typeclaw-cron bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const cronSkill = skills.find((s) => s.name === 'typeclaw-cron')
    expect(cronSkill).toBeDefined()
    expect(cronSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the typeclaw-config bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const configSkill = skills.find((s) => s.name === 'typeclaw-config')
    expect(configSkill).toBeDefined()
    expect(configSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes the agent-browser bundled skill to the agent', async () => {
    const loader = await createResourceLoader({ agentDir })

    const { skills } = loader.getSkills()
    const browserSkill = skills.find((s) => s.name === 'agent-browser')
    expect(browserSkill).toBeDefined()
    expect(browserSkill?.description.length).toBeGreaterThan(0)
  })

  test('exposes user-installed skills under <agentDir>/.agents/skills/ to the agent', async () => {
    // given
    await mkdir(join(agentDir, '.agents', 'skills', 'user-tool'), { recursive: true })
    await writeFile(
      join(agentDir, '.agents', 'skills', 'user-tool', 'SKILL.md'),
      '---\nname: user-tool\ndescription: A user-installed skill\n---\n\nbody',
    )

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const { skills } = loader.getSkills()
    const userSkill = skills.find((s) => s.name === 'user-tool')
    expect(userSkill).toBeDefined()
    expect(userSkill?.description).toBe('A user-installed skill')
  })

  test('does not throw when <agentDir>/.agents/skills/ does not exist', async () => {
    // when / then
    const loader = await createResourceLoader({ agentDir })
    expect(loader.getSkills().skills).toBeDefined()
  })

  test('exposes muscle-memory skills under <agentDir>/memory/skills/ to the agent', async () => {
    // given
    await mkdir(join(agentDir, 'memory', 'skills', 'release-checklist'), { recursive: true })
    await writeFile(
      join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md'),
      '---\nname: release-checklist\ndescription: Use when shipping a release.\nsource: muscle-memory\n---\n\nbody',
    )

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const { skills } = loader.getSkills()
    const memorySkill = skills.find((s) => s.name === 'release-checklist')
    expect(memorySkill).toBeDefined()
    expect(memorySkill?.description).toBe('Use when shipping a release.')
  })

  test('does not throw when <agentDir>/memory/skills/ does not exist', async () => {
    // when / then
    const loader = await createResourceLoader({ agentDir })
    expect(loader.getSkills().skills).toBeDefined()
  })

  test('appends a dirty-files nudge to the system prompt when the agent folder has uncommitted changes', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'tracked file')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])
    await writeFile(join(agentDir, 'IDENTITY.md'), 'modified content')

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).toContain('## Uncommitted changes at session start')
    expect(prompt).toContain('IDENTITY.md')
  })

  test('omits the dirty-files nudge entirely when the worktree is clean', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'committed')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])

    // when
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Uncommitted changes at session start')
  })

  test('omits the dirty-files nudge when the agent folder is not a git repo', async () => {
    // when (no .git in agentDir)
    const loader = await createResourceLoader({ agentDir })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain('## Uncommitted changes at session start')
  })

  test('places the nudge after the plugin session.prompt mutation so plugin-injected text remains in the cacheable prefix', async () => {
    // given
    await initGitRepo(agentDir)
    await writeFile(join(agentDir, 'IDENTITY.md'), 'baseline')
    await runGit(agentDir, ['add', 'IDENTITY.md'])
    await runGit(agentDir, ['commit', '-m', 'init'])
    await writeFile(join(agentDir, 'IDENTITY.md'), 'dirty edit')

    const hooks = createHookBus()
    hooks.registerAll('plugin-test', agentDir, silentLogger(), {
      'session.prompt': async (event) => {
        event.prompt = `${event.prompt}\n\nPLUGIN-INJECTED-MARKER`
      },
    })
    const registry: PluginRegistry = {
      tools: [],
      subagents: [],
      cronJobs: [],
      skills: [],
      skillsDirs: [],
    }

    // when
    const loader = await createResourceLoader({
      agentDir,
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    const pluginIdx = prompt.indexOf('PLUGIN-INJECTED-MARKER')
    const nudgeIdx = prompt.indexOf('## Uncommitted changes at session start')
    expect(pluginIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(pluginIdx)
  })
})

describe('createOverrideResourceLoader', () => {
  test('uses the override string verbatim as the system prompt', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    expect(loader.getSystemPrompt()).toBe('SUBAGENT PROMPT')
  })

  test('does not include the typeclaw default system prompt', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    const prompt = loader.getSystemPrompt() ?? ''
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT)
  })

  test('does not append SYSTEM.md files discovered by pi defaults', async () => {
    // when
    const loader = await createOverrideResourceLoader('SUBAGENT PROMPT')

    // then
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })
})

describe('buildChannelTools', () => {
  function makeRouter() {
    return createChannelRouter({
      agentDir: '/tmp/test-channel-tools',
      configForAdapter: () => ({
        allow: ['*'],
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      }),
    })
  }

  const channelOrigin: SessionOrigin = {
    kind: 'channel',
    adapter: 'slack-bot',
    workspace: 'T0',
    chat: 'C0',
    thread: '1700000000.000100',
  }

  const tuiOrigin: SessionOrigin = { kind: 'tui', sessionId: 'ses-tui-1' }
  const cronOrigin: SessionOrigin = { kind: 'cron', jobId: 'j1', jobKind: 'prompt' }

  test('exposes channel_send, channel_reply, AND channel_history when origin is channel', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, channelOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['channel_history', 'channel_reply', 'channel_send'])
  })

  test('exposes only channel_send (no reply or history) when origin is non-channel', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, tuiOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['channel_send'])
  })

  test('exposes only channel_send when origin is cron (not channel-routed)', () => {
    // given
    const router = makeRouter()

    // when
    const tools = buildChannelTools(router, cronOrigin)

    // then
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['channel_send'])
  })

  test('exposes no channel tools when channelRouter is undefined', () => {
    // when
    const tools = buildChannelTools(undefined, channelOrigin)
    // then
    expect(tools).toHaveLength(0)
  })

  test('exposes no channel tools when origin is undefined and channelRouter is undefined', () => {
    // when
    const tools = buildChannelTools(undefined, undefined)
    // then
    expect(tools).toHaveLength(0)
  })

  test('exposes only channel_send when channelRouter is set but origin is undefined', () => {
    // when
    const tools = buildChannelTools(makeRouter(), undefined)
    // then
    expect(tools.map((t) => t.name)).toEqual(['channel_send'])
  })
})

describe('getBundledSkillsDir', () => {
  test.each([['typeclaw-cron'], ['typeclaw-config'], ['agent-browser']])(
    'points at a directory containing %s/SKILL.md',
    (skill) => {
      const dir = getBundledSkillsDir()
      expect(existsSync(join(dir, skill, 'SKILL.md'))).toBe(true)
    },
  )

  test.each([['typeclaw-cron'], ['typeclaw-config'], ['agent-browser']])(
    '%s SKILL.md has YAML frontmatter with name and description',
    async (skill) => {
      const path = join(getBundledSkillsDir(), skill, 'SKILL.md')
      const raw = await readFile(path, 'utf8')

      expect(raw.startsWith('---\n')).toBe(true)
      const frontmatterEnd = raw.indexOf('\n---\n', 4)
      expect(frontmatterEnd).toBeGreaterThan(0)
      const frontmatter = raw.slice(4, frontmatterEnd)
      expect(frontmatter).toMatch(new RegExp(`^name:\\s*${skill}\\s*$`, 'm'))
      expect(frontmatter).toMatch(/^description:\s*\S/m)
    },
  )
})

describe('formatRestartNotice', () => {
  test('uses the SYSTEM MESSAGE framing convention required for runtime-injected text', () => {
    // when
    const text = formatRestartNotice('2026-05-03T17:39:00.000Z')

    // then
    expect(text).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/\n---\n$/)
    expect(text).toContain('Do not acknowledge or reply to this notice unless a human directly')
  })

  test('embeds the restart timestamp in the body and the guidance', () => {
    // when
    const text = formatRestartNotice('2026-05-03T17:39:00.000Z')

    // then
    const matches = text.match(/2026-05-03T17:39:00\.000Z/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

describe('subscribeRestartNotice', () => {
  test('appends a typeclaw.restart custom_message entry on a container-restarting broadcast', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: '2026-05-03T17:39:00.000Z' },
    })

    // then
    const entries = sessionManager.getEntries()
    const restartEntries = entries.filter(
      (e): e is typeof e & { type: 'custom_message' } => e.type === 'custom_message',
    )
    expect(restartEntries).toHaveLength(1)
    const entry = restartEntries[0]!
    expect(entry.customType).toBe('typeclaw.restart')
    expect(entry.display).toBe(false)
    expect(typeof entry.content === 'string' ? entry.content : '').toContain('2026-05-03T17:39:00.000Z')
    expect(typeof entry.content === 'string' ? entry.content : '').toContain('**[SYSTEM MESSAGE — not from a human]**')
  })

  test('ignores broadcasts whose payload kind is not container-restarting', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'something-else', restartedAt: '2026-05-03T17:39:00.000Z' },
    })
    stream.publish({ target: { kind: 'broadcast' }, payload: { foo: 'bar' } })
    stream.publish({ target: { kind: 'broadcast' }, payload: null })

    // then
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('ignores container-restarting broadcasts with non-string restartedAt', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionManager)

    // when
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: 12345 },
    })

    // then
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('returns null and is a no-op when stream is undefined', () => {
    // given
    const sessionManager = SessionManager.inMemory()

    // when
    const unsub = subscribeRestartNotice(undefined, sessionManager)

    // then
    expect(unsub).toBeNull()
    expect(sessionManager.getEntries()).toHaveLength(0)
  })

  test('stops appending entries after the returned unsubscribe is called', () => {
    // given
    const stream = createStream()
    const sessionManager = SessionManager.inMemory()
    const unsub = subscribeRestartNotice(stream, sessionManager)
    expect(unsub).not.toBeNull()
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: '2026-05-03T17:39:00.000Z' },
    })
    expect(sessionManager.getEntries()).toHaveLength(1)

    // when
    unsub?.()
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: '2026-05-03T18:00:00.000Z' },
    })

    // then
    expect(sessionManager.getEntries()).toHaveLength(1)
  })

  test('fans out a single broadcast to multiple subscribed sessions (composition mutation check)', () => {
    // given two sessions sharing one stream — simulating two live channel
    // sessions in a dying container at restart time.
    const stream = createStream()
    const sessionA = SessionManager.inMemory()
    const sessionB = SessionManager.inMemory()
    subscribeRestartNotice(stream, sessionA)
    subscribeRestartNotice(stream, sessionB)

    // when the restart tool publishes once
    stream.publish({
      target: { kind: 'broadcast' },
      payload: { kind: 'container-restarting', restartedAt: '2026-05-03T17:39:00.000Z' },
    })

    // then both sessions get the notice independently
    const aEntries = sessionA.getEntries().filter((e) => e.type === 'custom_message')
    const bEntries = sessionB.getEntries().filter((e) => e.type === 'custom_message')
    expect(aEntries).toHaveLength(1)
    expect(bEntries).toHaveLength(1)
    expect((aEntries[0] as { customType: string }).customType).toBe('typeclaw.restart')
    expect((bEntries[0] as { customType: string }).customType).toBe('typeclaw.restart')
  })
})
