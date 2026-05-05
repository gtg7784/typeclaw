import type { z } from 'zod'

import type { BuiltinToolRef, DefinedPlugin, PluginContext, PluginExports, Subagent, Tool } from './types'

type DefinePluginSpec<S extends z.ZodType<unknown> | undefined> =
  S extends z.ZodType<infer T>
    ? {
        configSchema: S
        plugin: (ctx: PluginContext<T>) => Promise<PluginExports>
      }
    : {
        plugin: (ctx: PluginContext<unknown>) => Promise<PluginExports>
      }

export function definePlugin<S extends z.ZodType<unknown> | undefined = undefined>(
  spec: DefinePluginSpec<S>,
): DefinedPlugin<S extends z.ZodType<infer T> ? T : unknown> {
  return spec as DefinedPlugin<S extends z.ZodType<infer T> ? T : unknown>
}

export function defineTool<P>(tool: Tool<P>): Tool<P> {
  return tool
}

export function defineSubagent<P>(subagent: Subagent<P>): Subagent<P> {
  return subagent
}

export const readTool: BuiltinToolRef = { __builtinTool: 'read' }
export const bashTool: BuiltinToolRef = { __builtinTool: 'bash' }
export const editTool: BuiltinToolRef = { __builtinTool: 'edit' }
export const writeTool: BuiltinToolRef = { __builtinTool: 'write' }
export const grepTool: BuiltinToolRef = { __builtinTool: 'grep' }
export const findTool: BuiltinToolRef = { __builtinTool: 'find' }
export const lsTool: BuiltinToolRef = { __builtinTool: 'ls' }
