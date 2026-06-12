import { splitCitationsBySection } from './citations'

export type DreamingMetrics = {
  topicsCreated: number
  topicsRemoved: number
  supersededDelta: number
}

// Snapshots are keyed by absolute shard path → file bytes (captureShardSnapshot).
// supersededDelta is the net change in citations under `superseded:` across all
// shards, i.e. how many fragments were overturned this run.
export function computeDreamingMetrics(before: Map<string, Buffer>, after: Map<string, Buffer>): DreamingMetrics {
  let topicsCreated = 0
  for (const path of after.keys()) if (!before.has(path)) topicsCreated += 1

  let topicsRemoved = 0
  for (const path of before.keys()) if (!after.has(path)) topicsRemoved += 1

  const supersededDelta = countSuperseded(after) - countSuperseded(before)

  return { topicsCreated, topicsRemoved, supersededDelta }
}

function countSuperseded(snapshot: Map<string, Buffer>): number {
  let total = 0
  for (const bytes of snapshot.values()) total += splitCitationsBySection(bytes.toString('utf8')).superseded.size
  return total
}
