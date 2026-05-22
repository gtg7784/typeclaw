// Strength signals for topic shards, derived mechanically from citations.
//
// What "strength" means here is structural, not semantic — we measure how
// many times and over how many distinct days a topic has been reinforced by
// observation fragments. The reasoning lives in dreaming.ts's system prompt;
// this file only produces the numbers the prompt will reference.
//
// Why distinct days matters more than raw citation count: five fragments on
// one day == one debugging session that mentioned the same thing five times
// (a transient burst). Five fragments across five days == a recurring fact
// the user keeps coming back to (a stable signal). The promotion ladder in
// the dreaming subagent's prompt is gated on distinct-days, not count, for
// exactly this reason — see the "spacing effect" note in the PR description.
//
// All numbers here are deterministic. The same topic text parsed against the
// same `today` always yields the same TopicStrength list. There is no LLM
// involvement at this layer; the subagent receives these numbers as ground
// truth and uses them to decide what to merge or demote.

import { parseTopics, type Topic } from './topics'

export type TopicStrength = {
  heading: string
  citationCount: number
  distinctDays: number
  // ISO date (yyyy-MM-dd) of the most recent citation, or null when the
  // topic has zero citations. Null is distinct from "very old": a topic with
  // no citations at all is a different shape than one whose last citation
  // was a year ago, and the subagent should treat them differently (the
  // former is a typo or a manual edit; the latter is a decayed-but-real
  // topic).
  lastReinforcedDate: string | null
  // Whole-day delta from today to lastReinforcedDate. Null when
  // lastReinforcedDate is null. Negative values are clamped to 0 (a citation
  // dated in the future is treated as "today" — the only way this happens
  // is a clock skew between memory-logger and the dreaming run, and the
  // subagent shouldn't be punished for the runtime's confusion).
  daysSinceLastReinforced: number | null
}

export function computeTopicStrengths(memoryText: string, today: string): TopicStrength[] {
  const topics = parseTopics(memoryText)
  return topics.map((topic) => computeOneTopicStrength(topic, today))
}

function computeOneTopicStrength(topic: Topic, today: string): TopicStrength {
  const citationCount = topic.citations.length
  const distinctDates = new Set(topic.citations.map((c) => c.date))
  const distinctDays = distinctDates.size
  const lastReinforcedDate = pickLatestDate([...distinctDates])
  const daysSinceLastReinforced = lastReinforcedDate ? daysBetween(today, lastReinforcedDate) : null
  return {
    heading: topic.heading,
    citationCount,
    distinctDays,
    lastReinforcedDate,
    daysSinceLastReinforced,
  }
}

function pickLatestDate(dates: readonly string[]): string | null {
  if (dates.length === 0) return null
  let latest = dates[0]!
  for (let i = 1; i < dates.length; i++) {
    const candidate = dates[i]!
    if (candidate.localeCompare(latest) > 0) latest = candidate
  }
  return latest
}

// Whole-day delta in UTC between two yyyy-MM-dd strings. Date.UTC parses each
// date as midnight UTC, so the difference is always an integer count of
// 86_400_000ms windows regardless of timezone or DST. Returns 0 for invalid
// inputs (treats the topic as "fresh" rather than throwing — defensive
// because both inputs are produced by the runtime, but a corrupted topic-shard
// citation date is the kind of thing we want to fail open on).
function daysBetween(today: string, earlier: string): number {
  const todayMs = parseIsoDateUtc(today)
  const earlierMs = parseIsoDateUtc(earlier)
  if (todayMs === null || earlierMs === null) return 0
  const deltaDays = Math.floor((todayMs - earlierMs) / 86_400_000)
  return deltaDays < 0 ? 0 : deltaDays
}

function parseIsoDateUtc(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const year = Number.parseInt(match[1]!, 10)
  const month = Number.parseInt(match[2]!, 10)
  const day = Number.parseInt(match[3]!, 10)
  const ms = Date.UTC(year, month - 1, day)
  return Number.isFinite(ms) ? ms : null
}

// Render the strength signals as a markdown table the dreaming subagent can
// read at the top of its user prompt. Returns an empty string when the
// topic list is empty so the caller can prepend it unconditionally.
//
// Column choices: heading first because it's the human-recognizable handle;
// `cites` and `days` are short enough to align nicely; `last` carries the
// date itself so the subagent can compare to today without re-doing the
// arithmetic. Headings are truncated to keep the table readable when a
// topic was given a long sentence-shaped heading — the citation count is
// still accurate, only the display label is shortened.
export function renderTopicStrengthsTable(strengths: readonly TopicStrength[]): string {
  if (strengths.length === 0) return ''
  const rows = strengths.map((s) => ({
    heading: truncateHeading(s.heading || '(untitled)'),
    cites: String(s.citationCount),
    days: String(s.distinctDays),
    last: s.lastReinforcedDate ?? '—',
    ageDays: s.daysSinceLastReinforced === null ? '—' : String(s.daysSinceLastReinforced),
  }))
  const lines = ['| topic | cites | days | last reinforced | age (d) |', '| --- | ---: | ---: | --- | ---: |']
  for (const row of rows) {
    lines.push(`| ${row.heading} | ${row.cites} | ${row.days} | ${row.last} | ${row.ageDays} |`)
  }
  return lines.join('\n')
}

const HEADING_MAX_CHARS = 60

function truncateHeading(heading: string): string {
  const escaped = heading.replace(/\|/g, '\\|')
  if (escaped.length <= HEADING_MAX_CHARS) return escaped
  return `${escaped.slice(0, HEADING_MAX_CHARS - 1)}…`
}
