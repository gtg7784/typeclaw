import type {
  HookContext,
  Hooks,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionPromptEvent,
  SessionStartEvent,
  ToolAfterEvent,
  ToolBeforeEvent,
  ToolBeforeResult,
} from './types'

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
  runToolBefore: (event: ToolBeforeEvent) => Promise<{ block: true; reason: string } | undefined>
  runToolAfter: (event: ToolAfterEvent) => Promise<void>
  count: (name: keyof Hooks) => number
}

type Registries = {
  'session.start': RegisteredHook<'session.start'>[]
  'session.end': RegisteredHook<'session.end'>[]
  'session.idle': RegisteredHook<'session.idle'>[]
  'session.prompt': RegisteredHook<'session.prompt'>[]
  'tool.before': RegisteredHook<'tool.before'>[]
  'tool.after': RegisteredHook<'tool.after'>[]
}

export function createHookBus(): HookBus {
  const r: Registries = {
    'session.start': [],
    'session.end': [],
    'session.idle': [],
    'session.prompt': [],
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
      if (hooks['tool.before']) r['tool.before'].push({ ...base, handler: hooks['tool.before'] })
      if (hooks['tool.after']) r['tool.after'].push({ ...base, handler: hooks['tool.after'] })
    },

    unregisterAll(pluginName) {
      r['session.start'] = r['session.start'].filter((h) => h.pluginName !== pluginName)
      r['session.end'] = r['session.end'].filter((h) => h.pluginName !== pluginName)
      r['session.idle'] = r['session.idle'].filter((h) => h.pluginName !== pluginName)
      r['session.prompt'] = r['session.prompt'].filter((h) => h.pluginName !== pluginName)
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
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.end', err)
        }
      }
    },

    async runSessionIdle(event) {
      for (const reg of r['session.idle']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.idle', err)
        }
      }
    },

    async runSessionPrompt(event) {
      for (const reg of r['session.prompt']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.prompt', err)
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
