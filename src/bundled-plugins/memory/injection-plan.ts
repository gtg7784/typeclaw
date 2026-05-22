import type { TopicShard } from './load-shards'

export const DEFAULT_INJECTION_BUDGET_BYTES = 16 * 1024
export const MIN_INJECTION_BUDGET_BYTES = 4 * 1024

export type InjectionPlan =
  | { mode: 'direct'; shards: TopicShard[] }
  | { mode: 'index'; shards: TopicShard[]; budget: number; totalBytes: number }

export function buildInjectionPlan(shards: TopicShard[], options: { budgetBytes?: number } = {}): InjectionPlan {
  const budget = options.budgetBytes ?? DEFAULT_INJECTION_BUDGET_BYTES
  const totalBytes = shards.reduce((sum, shard) => sum + Buffer.byteLength(shard.body, 'utf8'), 0)
  if (totalBytes <= budget) return { mode: 'direct', shards }
  return { mode: 'index', shards, budget, totalBytes }
}
