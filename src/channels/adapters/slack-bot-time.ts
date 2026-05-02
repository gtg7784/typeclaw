// Slack timestamps are "<seconds>.<microseconds>" strings. Convert to ms
// so callers can sort/render chronologically without re-parsing. Lives in
// its own file to break the import cycle between slack-bot.ts (which
// imports the classifier) and slack-bot-classify.ts (which needs to stamp
// inbound `ts` at classify time).
export function slackTsToMillis(ts: string): number {
  const parsed = Number.parseFloat(ts)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 1000)
}
