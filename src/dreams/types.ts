// Mirrored from the bundled memory plugin's dreaming subagent rather than
// imported: this host-stage viewer must stay decoupled from runtime plugin
// internals, and only needs to RECOGNIZE the emoji set, not own it. The
// grammar test asserts this list stays in sync with the runtime's pool.
export const DREAM_EMOJI_POOL = ['💤', '🌙', '⭐', '🛌', '😴', '🧠', '💭', '🔮'] as const
export type DreamEmoji = (typeof DREAM_EMOJI_POOL)[number]

export type DreamCategory = 'fragments' | 'skills' | 'watermarks-only' | 'snapshot' | 'other'

export type DreamEntry = {
  sha: string
  shortSha: string
  subject: string
  committedAt: string
  isDreamCommit: boolean
  summary: string | null
  emoji: DreamEmoji | null
  categories: DreamCategory[]
  detail?: DreamEntryDetail
}

export type DreamEntryDetail = {
  addedFragments: FragmentEventSummary[]
  changedTopics: TopicShardChange[]
  createdSkills: SkillCreation[]
  stateChanged: boolean
  parseWarnings: string[]
}

export type FragmentEventSummary = {
  id: string
  streamDate: string | null
  topic: string | null
  bodyPreview: string | null
}

export type ShardChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'

export type TopicShardChange = {
  path: string
  slug: string
  status: ShardChangeStatus
  additions: number | null
  deletions: number | null
}

export type SkillCreation = {
  name: string
  path: string
}
