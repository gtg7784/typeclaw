// Citation-superset safety net for the dreaming subagent's MEMORY.md
// rewrite. After every dreaming run that touched MEMORY.md, we check that
// the union of fragment ids cited in the NEW file is a superset of the
// union cited in the OLD file. If any previously-cited id is missing from
// the rewrite, the rewrite is rejected.
//
// Why this exists: the daily-stream GC in compactDailyStreams drops any
// fragment that is `dreamedIds ∧ ¬citedIds`. Citations in MEMORY.md are
// the only thing that keeps a fragment alive past its first dreaming run.
// If the subagent rewrites MEMORY.md and accidentally omits a citation —
// either by garbling a merged topic's fragments: list or by dropping a
// topic entirely — the next compaction call permanently deletes the
// underlying fragment from the daily JSONL. There is no recovery beyond
// `git revert` of the snapshot commit, and even that loses anything the
// agent wrote since.
//
// The subagent's new rule 5 explicitly allows merging topics and rewriting
// conclusion paragraphs, with the requirement that the merged topic's
// `fragments:` list is the union of its source topics'. The LLM can fail
// to honor that — especially across hundreds of runs over months — so the
// mechanical check is the safety floor.
//
// Detection only. The handler decides what to do with the verdict (revert
// MEMORY.md to its pre-run bytes, skip daily-stream compaction, still
// advance the dreamed-id set so we do not loop on the same fragments).

import { parseCitations } from './citations'

export type CitationSupersetVerdict = { ok: true } | { ok: false; missing: Array<{ date: string; fragmentId: string }> }

// Compare the OLD MEMORY.md to the NEW MEMORY.md and report any
// fragment id that the OLD cited and the NEW does not. Empty old text
// (first-ever dreaming run, prior file missing) is treated as the empty
// citation set — any new file passes by construction.
export function checkCitationSuperset(oldText: string, newText: string): CitationSupersetVerdict {
  const oldCitations = parseCitations(oldText)
  if (oldCitations.size === 0) return { ok: true }

  const newCitations = parseCitations(newText)
  const missing: Array<{ date: string; fragmentId: string }> = []

  const dates = [...oldCitations.keys()].sort()
  for (const date of dates) {
    const oldIds = oldCitations.get(date) ?? new Set<string>()
    const newIds = newCitations.get(date) ?? new Set<string>()
    const oldIdList = [...oldIds].sort()
    for (const id of oldIdList) {
      if (!newIds.has(id)) missing.push({ date, fragmentId: id })
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

// Pretty-print the verdict's missing ids for log output. Keeps the line
// short by reporting count + first N ids; the full list is reconstructable
// from MEMORY.md's git history if forensics are ever needed.
export function summarizeMissingCitations(missing: ReadonlyArray<{ date: string; fragmentId: string }>): string {
  const total = missing.length
  const sample = missing.slice(0, 3).map((m) => `${m.date}#${m.fragmentId}`)
  if (total <= 3) return sample.join(', ')
  return `${sample.join(', ')} (+${total - 3} more)`
}
