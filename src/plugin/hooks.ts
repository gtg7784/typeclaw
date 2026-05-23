import type {
  HookContext,
  Hooks,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionPromptEvent,
  SessionStartEvent,
  SessionTurnEndEvent,
  SessionTurnStartEvent,
  ToolAfterEvent,
  ToolBeforeEvent,
  ToolBeforeResult,
} from './types'

// Per-handler ceiling for session.idle. The channels-side router wraps the
// whole chain at SESSION_IDLE_TIMEOUT_MS = 30s; this inner bound fires
// first so the offending plugin gets named in the logs instead of the
// chain-level timeout swallowing attribution. A handler that legitimately
// needs longer (large transcript replay, dreaming subagent) is rare — and
// `setTimeout`-driven plugins like memory-logger normally return in
// milliseconds. 25s leaves headroom under the chain watchdog.
export const IDLE_HANDLER_TIMEOUT_MS = 25_000

// Per-handler ceiling for session.end. Cron consumer's runPrompt and the
// subagent runner both await session.hooks.runSessionEnd inside their
// finally blocks — a hung handler wedges inFlight forever, so the next
// scheduler fire is silently coalesced and the cron job appears dead.
// The memory plugin's session.end awaits a serialized memory-logger chain
// that can stall on a half-open LLM stream; 60s is generous headroom for
// legitimate transcript flush while still bounding the failure mode.
export const END_HANDLER_TIMEOUT_MS = 60_000

// Per-handler ceiling for session.prompt. session.prompt fires
// synchronously inside createResourceLoader (src/agent/index.ts), which on
// channel-origin cold start is itself inside ensureLive's 30s watchdog
// (src/channels/router.ts). An unbounded hook there silently consumes the
// outer budget and times out without naming the offending plugin in the
// logs. 20s leaves ~10s of headroom for the rest of the cold-start chain
// (loadSelf, loadMemory shard reads, prefetchChannelContext) before
// ensureLive fires.
//
// The bundled memory plugin's session.prompt fires memory-retrieval
// detached, so it returns in <1ms in steady state; this ceiling guards
// third-party hooks that legitimately need to do work inline, AND a
// regression in the memory plugin that re-introduces an inline await.
export const PROMPT_HANDLER_TIMEOUT_MS = 20_000

export type RegisteredHook<K extends keyof Hooks> = {
  pluginName: string
  agentDir: string
  logger: PluginLogger
  handler: NonNullable<Hooks[K]>
}

export type HookBus = {
  registerAll: (pluginName: string, agentDir: string, logger: PluginLogger, hooks: Hooks) => void
  unregisterAll: (pluginName: string) => void
  runSessionStart: (event: SessionStartEvent) => Promise<void>
  runSessionEnd: (event: SessionEndEvent) => Promise<void>
  runSessionIdle: (event: SessionIdleEvent) => Promise<void>
  runSessionPrompt: (event: SessionPromptEvent) => Promise<void>
  runSessionTurnStart: (event: SessionTurnStartEvent) => Promise<void>
  runSessionTurnEnd: (event: SessionTurnEndEvent) => Promise<void>
  runToolBefore: (event: ToolBeforeEvent) => Promise<{ block: true; reason: string } | undefined>
  runToolAfter: (event: ToolAfterEvent) => Promise<void>
  count: (name: keyof Hooks) => number
}

export type CreateHookBusOptions = {
  // Test seam: per-handler ceiling for session.idle invocations. Lets the
  // timeout path be exercised in tens of milliseconds instead of the 25s
  // production default.
  idleHandlerTimeoutMs?: number
  // Test seam: per-handler ceiling for session.end invocations.
  endHandlerTimeoutMs?: number
  // Test seam: per-handler ceiling for session.prompt invocations.
  promptHandlerTimeoutMs?: number
}

type Registries = {
  'session.start': RegisteredHook<'session.start'>[]
  'session.end': RegisteredHook<'session.end'>[]
  'session.idle': RegisteredHook<'session.idle'>[]
  'session.prompt': RegisteredHook<'session.prompt'>[]
  'session.turn.start': RegisteredHook<'session.turn.start'>[]
  'session.turn.end': RegisteredHook<'session.turn.end'>[]
  'tool.before': RegisteredHook<'tool.before'>[]
  'tool.after': RegisteredHook<'tool.after'>[]
}

export function createHookBus(options: CreateHookBusOptions = {}): HookBus {
  const idleHandlerTimeoutMs = options.idleHandlerTimeoutMs ?? IDLE_HANDLER_TIMEOUT_MS
  const endHandlerTimeoutMs = options.endHandlerTimeoutMs ?? END_HANDLER_TIMEOUT_MS
  const promptHandlerTimeoutMs = options.promptHandlerTimeoutMs ?? PROMPT_HANDLER_TIMEOUT_MS
  const r: Registries = {
    'session.start': [],
    'session.end': [],
    'session.idle': [],
    'session.prompt': [],
    'session.turn.start': [],
    'session.turn.end': [],
    'tool.before': [],
    'tool.after': [],
  }

  function ctx(reg: { pluginName: string; agentDir: string; logger: PluginLogger }): HookContext {
    return { agentDir: reg.agentDir, pluginName: reg.pluginName, logger: reg.logger }
  }

  return {
    registerAll(pluginName, agentDir, logger, hooks) {
      const base = { pluginName, agentDir, logger }
      if (hooks['session.start']) r['session.start'].push({ ...base, handler: hooks['session.start'] })
      if (hooks['session.end']) r['session.end'].push({ ...base, handler: hooks['session.end'] })
      if (hooks['session.idle']) r['session.idle'].push({ ...base, handler: hooks['session.idle'] })
      if (hooks['session.prompt']) r['session.prompt'].push({ ...base, handler: hooks['session.prompt'] })
      if (hooks['session.turn.start']) r['session.turn.start'].push({ ...base, handler: hooks['session.turn.start'] })
      if (hooks['session.turn.end']) r['session.turn.end'].push({ ...base, handler: hooks['session.turn.end'] })
      if (hooks['tool.before']) r['tool.before'].push({ ...base, handler: hooks['tool.before'] })
      if (hooks['tool.after']) r['tool.after'].push({ ...base, handler: hooks['tool.after'] })
    },

    unregisterAll(pluginName) {
      r['session.start'] = r['session.start'].filter((h) => h.pluginName !== pluginName)
      r['session.end'] = r['session.end'].filter((h) => h.pluginName !== pluginName)
      r['session.idle'] = r['session.idle'].filter((h) => h.pluginName !== pluginName)
      r['session.prompt'] = r['session.prompt'].filter((h) => h.pluginName !== pluginName)
      r['session.turn.start'] = r['session.turn.start'].filter((h) => h.pluginName !== pluginName)
      r['session.turn.end'] = r['session.turn.end'].filter((h) => h.pluginName !== pluginName)
      r['tool.before'] = r['tool.before'].filter((h) => h.pluginName !== pluginName)
      r['tool.after'] = r['tool.after'].filter((h) => h.pluginName !== pluginName)
    },

    async runSessionStart(event) {
      for (const reg of r['session.start']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.start', err)
        }
      }
    },

    async runSessionEnd(event) {
      for (const reg of r['session.end']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            endHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.end`,
          )
        } catch (err) {
          reportHookError(reg, 'session.end', err)
        }
      }
    },

    async runSessionIdle(event) {
      for (const reg of r['session.idle']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            idleHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.idle`,
          )
        } catch (err) {
          reportHookError(reg, 'session.idle', err)
        }
      }
    },

    async runSessionPrompt(event) {
      for (const reg of r['session.prompt']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            promptHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.prompt`,
          )
        } catch (err) {
          reportHookError(reg, 'session.prompt', err)
        }
      }
    },

    async runSessionTurnStart(event) {
      for (const reg of r['session.turn.start']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.turn.start', err)
        }
      }
    },

    async runSessionTurnEnd(event) {
      for (const reg of r['session.turn.end']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.turn.end', err)
        }
      }
    },

    // First plugin to return `{ block: true, reason }` short-circuits. Earlier
    // plugins' arg mutations remain visible to later plugins via the shared
    // event.args object.
    async runToolBefore(event) {
      for (const reg of r['tool.before']) {
        let result: ToolBeforeResult
        try {
          result = await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'tool.before', err)
          continue
        }
        if (result && typeof result === 'object' && (result as { block?: unknown }).block === true) {
          const reason = (result as { reason?: unknown }).reason
          return { block: true, reason: typeof reason === 'string' ? reason : 'blocked by plugin' }
        }
      }
      return undefined
    },

    async runToolAfter(event) {
      for (const reg of r['tool.after']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'tool.after', err)
        }
      }
    },

    count(name) {
      return r[name].length
    },
  }
}

function reportHookError(reg: { logger: PluginLogger }, hook: keyof Hooks, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  reg.logger.error(`hook ${hook} threw: ${message}`)
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
