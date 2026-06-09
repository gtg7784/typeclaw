import type { Readable, Writable } from 'node:stream'
import { styleText } from 'node:util'

import { SelectPrompt, settings } from '@clack/core'
import { limitOptions, S_BAR, S_BAR_END, S_RADIO_ACTIVE, S_RADIO_INACTIVE, symbolBar } from '@clack/prompts'

export type RefreshableOption<Value> = { value: Value; label: string; hint?: string; disabled?: boolean }

export type RefreshableSelectResult<Value> =
  | { kind: 'picked'; value: Value }
  | { kind: 'cancelled' }
  | { kind: 'refresh'; highlightValue: Value }

export type RefreshableSelectOptions<Value> = {
  message: string
  options: RefreshableOption<Value>[]
  initialValue?: Value
  maxItems?: number
  input?: Readable
  output?: Writable
}

export const REFRESH_KEY = 'r'

// The cursor's value, falling back to the first row so a refresh on an empty
// cursor still carries a stable highlight.
export function highlightAt<Value>(options: RefreshableOption<Value>[], cursor: number): Value | undefined {
  return options[cursor]?.value ?? options[0]?.value
}

// `refreshed` distinguishes an `r`-triggered abort (which also resolves to the
// cancel symbol) from a genuine ESC/Ctrl-C cancel.
export function toSelectResult<Value>(
  result: Value | symbol,
  refresh: { refreshed: boolean; highlightValue?: Value },
): RefreshableSelectResult<Value> {
  if (refresh.refreshed) return { kind: 'refresh', highlightValue: refresh.highlightValue as Value }
  if (typeof result === 'symbol') return { kind: 'cancelled' }
  return { kind: 'picked', value: result }
}

// A drop-in `select` that adds an `r`-to-refresh affordance. `@clack/prompts`'s
// `select` hides its prompt instance, so it can't expose the `key` event or the
// live cursor; dropping to `@clack/core`'s SelectPrompt is the only seam that
// can observe `r` without racing clack's own raw-mode stdin handling. The render
// below is ported from `@clack/prompts`'s select so the picker looks identical.
export async function refreshableSelect<Value>(
  opts: RefreshableSelectOptions<Value>,
): Promise<RefreshableSelectResult<Value>> {
  const optionsList = opts.options
  const refreshController = new AbortController()
  const refresh: { refreshed: boolean; highlightValue?: Value } = { refreshed: false }

  const prompt = new SelectPrompt<RefreshableOption<Value>>({
    options: optionsList,
    initialValue: opts.initialValue,
    signal: refreshController.signal,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    render() {
      return renderSelect(this as SelectPrompt<RefreshableOption<Value>>, opts.message, {
        ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      })
    },
  })

  prompt.on('key', (char) => {
    if (char !== REFRESH_KEY) return
    refresh.refreshed = true
    refresh.highlightValue = highlightAt(optionsList, prompt.cursor)
    // Reuse the prompt's own signal-abort cancel path: it sets state to cancel
    // and runs close() (raw-mode + listener teardown), resolving `.prompt()`.
    refreshController.abort()
  })

  const result = (await prompt.prompt()) as Value | symbol
  return toSelectResult(result, refresh)
}

function renderSelect<Value>(
  prompt: SelectPrompt<RefreshableOption<Value>>,
  message: string,
  limits: { maxItems?: number; output?: Writable },
): string {
  const hasGuide = settings.withGuide
  const titlePrefixBar = `${symbolBar(prompt.state)}  `
  const title = `${hasGuide ? `${styleText('gray', S_BAR)}\n` : ''}${titlePrefixBar}${message}\n`

  if (prompt.state === 'submit' || prompt.state === 'cancel') {
    const closePrefix = hasGuide ? `${styleText('gray', S_BAR)}  ` : ''
    const label = prompt.options[prompt.cursor]?.label ?? ''
    const closed = prompt.state === 'cancel' ? styleText(['strikethrough', 'dim'], label) : styleText('dim', label)
    const tail = prompt.state === 'cancel' && hasGuide ? `\n${styleText('gray', S_BAR)}` : ''
    return `${title}${closePrefix}${closed}${tail}`
  }

  const prefix = hasGuide ? `${styleText('cyan', S_BAR)}  ` : ''
  const prefixEnd = hasGuide ? styleText('cyan', S_BAR_END) : ''
  const rendered = limitOptions({
    cursor: prompt.cursor,
    options: prompt.options,
    ...(limits.maxItems !== undefined ? { maxItems: limits.maxItems } : {}),
    ...(limits.output !== undefined ? { output: limits.output } : {}),
    style: (item, active) => optionLine(item, item.disabled === true ? 'disabled' : active ? 'active' : 'inactive'),
  }).join(`\n${prefix}`)
  return `${title}${prefix}${rendered}\n${prefixEnd}\n`
}

function optionLine<Value>(option: RefreshableOption<Value>, state: 'inactive' | 'active' | 'disabled'): string {
  const { label } = option
  if (state === 'disabled') {
    const hint = option.hint !== undefined ? ` ${styleText('dim', `(${option.hint})`)}` : ''
    return `${styleText('gray', S_RADIO_INACTIVE)} ${styleText('gray', label)}${hint}`
  }
  if (state === 'active') {
    const hint = option.hint !== undefined ? ` ${styleText('dim', `(${option.hint})`)}` : ''
    return `${styleText('green', S_RADIO_ACTIVE)} ${label}${hint}`
  }
  return `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', label)}`
}
