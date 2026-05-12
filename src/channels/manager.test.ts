import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'

import { createChannelManager } from './manager'
import { defaultHistoryConfig, type ChannelAdapterConfig, type ChannelsConfig } from './schema'
import type { ChannelKey, InboundMessage } from './types'

type FakeAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
  startCalls: number
  stopCalls: number
}

function makeFakeAdapter(): FakeAdapter {
  const adapter = {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      adapter.startCalls++
    },
    async stop() {
      adapter.stopCalls++
    },
    isConnected() {
      return true
    },
  }
  return adapter
}

let agentDir: string
let cfg: ChannelsConfig

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-channels-mgr-'))
  cfg = {}
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

const enabledAdapterCfg = () => ({
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
  autoMarkRead: false,
})

describe('channel manager — slack adapter lifecycle', () => {
  test('starts slack adapter when both SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start slack adapter when SLACK_APP_TOKEN is missing', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })
})

describe('channel manager — reload detects missing tokens and stops adapter', () => {
  test('stops slack adapter when SLACK_BOT_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    delete env.SLACK_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(result.restartRequired).not.toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(1)
  })

  test('stops slack adapter when SLACK_APP_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    delete env.SLACK_APP_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when token value changes but is still present', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    env.SLACK_BOT_TOKEN = 'xoxb-rotated'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('slack-bot')
    expect(result.restartRequired).toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })

  test('forwards aliasesRef to the router so configured aliases trigger engagement', async () => {
    // given: a manager wired with `aliasesRef` returning ["윙키", "winky"], a
    //   slack-bot config with strict-mention trigger and stickiness off
    //   (so the ONLY remaining engagement paths are alias-substring match
    //   at engagement.ts:102 or the solo-human fallback at :174), and a
    //   participant cache primed with two distinct humans so the
    //   solo-human fallback is disabled and the alias path is the only
    //   engagement gate that can fire
    const slackCfg: ChannelAdapterConfig = {
      allow: ['*'],
      enabled: true,
      engagement: { trigger: ['mention'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }
    cfg['slack-bot'] = slackCfg
    const prompts: string[] = []
    const fakeSession = {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      abort: async () => {},
      sessionManager: { getLeafEntry: () => undefined },
    } as unknown as AgentSession
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['윙키', 'winky'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => makeFakeAdapter(),
      createSessionForChannel: async () => ({
        session: fakeSession,
        sessionId: 'ses_test_alias',
        dispose: async () => {},
      }),
    })

    const key: ChannelKey = { adapter: 'slack-bot', workspace: 'TXXX', chat: 'C111', thread: '1.0' }
    const baseInbound = (over: Partial<InboundMessage>): InboundMessage => ({
      ...key,
      text: '',
      externalMessageId: 'm0',
      authorId: 'U?',
      authorName: '?',
      authorIsBot: false,
      isBotMention: false,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2026-05-01T00:00:00.000Z'),
      ...over,
    })

    // when: a first @-mention inbound from human A primes the channel (so
    //   the session exists), then a non-alias inbound from human B brings
    //   the participant count to two (defeating the solo-human fallback),
    //   and finally a NON-mention inbound from A whose text contains only
    //   the configured alias "윙키" arrives — every structural trigger
    //   (mention, reply, dm, sticky) is off, leaving alias-match as the
    //   sole gate
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm1', text: 'hello bot', authorId: 'U_A', authorName: 'A', isBotMention: true }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm2', text: 'side comment', authorId: 'U_B', authorName: 'B' }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    const promptsBeforeAlias = prompts.length
    await mgr.router.route(baseInbound({ externalMessageId: 'm3', text: '윙키야', authorId: 'U_A', authorName: 'A' }))
    await mgr.router.__testing!.flushDebounce(key)

    // then: the alias-only inbound produces exactly one new prompt; if the
    //   manager dropped `aliasesRef` on the floor (the bug this fix
    //   addresses), `selfAliases` would fall back to `[basename(agentDir)]`
    //   only, "윙키야" would not match any alias, and with the solo-human
    //   fallback disabled by U_B's prior inbound the message would be
    //   silently observed — promptsAfterAlias would equal promptsBeforeAlias
    const promptsAfterAlias = prompts.length
    expect(promptsAfterAlias - promptsBeforeAlias).toBe(1)
    expect(prompts[prompts.length - 1]).toContain('윙키야')
  })

  test('forwards selfAliasesRef to the slack adapter so the classifier can anchor threads on alias-only inbounds', async () => {
    // given: a manager wired with `aliasesRef` returning ["윙키", "winky"]
    //   AND a `createSlackAdapter` test seam that captures the options the
    //   manager passes. The point of this test is the wiring itself: if a
    //   future refactor drops `selfAliasesRef` from manager.ts, every
    //   adapter-side and router-side test still passes (the seams keep
    //   their own fake aliases), but the production thread-anchoring path
    //   silently regresses. This test fails the moment that wiring
    //   disappears, so it's the only mutation guard between manager.ts
    //   and slack-bot-classify.ts.
    cfg['slack-bot'] = enabledAdapterCfg()
    let captured: { selfAliasesRef?: () => readonly string[] } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['윙키', 'winky'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    // when: the adapter is constructed at start
    await mgr.start()

    // then: the captured options carry a live selfAliasesRef whose result
    //   includes both the configured aliases AND the implicit dir-name
    //   alias the router seeds at construction (basename(agentDir))
    expect(captured?.selfAliasesRef).toBeDefined()
    const aliases = captured!.selfAliasesRef!()
    expect(aliases).toContain('윙키')
    expect(aliases).toContain('winky')

    await mgr.stop()
  })

  test('stops discord adapter when DISCORD_BOT_TOKEN disappears (parity with slack)', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => fake,
    })

    await mgr.start()
    delete env.DISCORD_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('discord-bot')
    expect(fake.stopCalls).toBe(1)
  })
})

describe('channel manager — telegram adapter lifecycle', () => {
  test('starts telegram adapter and forwards TELEGRAM_BOT_TOKEN to it', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    let captured: { token?: string; configRef?: () => unknown } | undefined
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-abc' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: (opts) => {
        captured = opts
        return fake
      },
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)
    // Mutation guard: a refactor that swapped TELEGRAM_BOT_TOKEN for the
    // wrong env var (or hardcoded a string) would still pass any test
    // that didn't capture the actual token passed to the adapter.
    expect(captured?.token).toBe('tg-tok-abc')
    expect(typeof captured?.configRef).toBe('function')

    await mgr.stop()
    expect(fake.stopCalls).toBe(1)
  })

  test('does not start telegram adapter when TELEGRAM_BOT_TOKEN is missing', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = {}
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('stops telegram adapter when TELEGRAM_BOT_TOKEN is removed from env on reload', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    delete env.TELEGRAM_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('telegram-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when TELEGRAM_BOT_TOKEN value changes but is still present', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-1' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()

    env.TELEGRAM_BOT_TOKEN = 'tg-tok-2'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('telegram-bot')
    expect(result.restartRequired).toContain('telegram-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })
})

describe('channel manager — kakaotalk credential preflight', () => {
  const writeCredentialsFile = async (dir: string): Promise<string> => {
    const credDir = join(dir, 'workspace', '.agent-messenger')
    await mkdir(credDir, { recursive: true })
    const path = join(credDir, 'kakaotalk-credentials.json')
    await writeFile(path, JSON.stringify({ current_account: 'a1', accounts: {} }))
    return path
  }

  test('starts kakaotalk adapter when credentials file exists at workspace/.agent-messenger/', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeCredentialsFile(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start kakaotalk adapter when credentials file is missing', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('honors AGENT_MESSENGER_CONFIG_DIR override for credential lookup', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const overrideDir = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-override-'))
    try {
      const credPath = join(overrideDir, 'kakaotalk-credentials.json')
      await writeFile(credPath, '{}')
      const fake = makeFakeAdapter()
      const mgr = createChannelManager({
        agentDir,
        channelsConfigRef: () => cfg,
        env: { AGENT_MESSENGER_CONFIG_DIR: overrideDir },
        createKakaotalkAdapter: () => fake,
      })

      await mgr.start()
      expect(fake.startCalls).toBe(1)
      await mgr.stop()
    } finally {
      await rm(overrideDir, { recursive: true, force: true })
    }
  })

  test('reload stops kakaotalk adapter when credentials file is removed', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const path = await writeCredentialsFile(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await rm(path)

    const result = await mgr.reload()
    expect(result.stopped).toContain('kakaotalk')
    expect(fake.stopCalls).toBe(1)
  })

  test('reload reports credential rotation (not stop) when file content changes', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const path = await writeCredentialsFile(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    // Different JSON content → different SHA-256 → credential rotation
    // detected. Per fix #7, we hash the file rather than relying on
    // mtime/size, so writing back identical bytes would correctly NOT
    // trigger a rotation (asserted by the negative case below).
    await writeFile(path, JSON.stringify({ current_account: 'a2', accounts: {} }))

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('kakaotalk')
    expect(result.restartRequired).toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })

  test('reload does not report rotation when file is rewritten with identical bytes', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const path = await writeCredentialsFile(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    // Re-write the same JSON. mtime+size would have flagged this; content
    // hash correctly recognizes it as a no-op.
    await writeFile(path, JSON.stringify({ current_account: 'a1', accounts: {} }))

    const result = await mgr.reload()
    expect(result.restartRequired).not.toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })
})
