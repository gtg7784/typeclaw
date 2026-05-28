export function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  // New classifiers store bare Slack file ids; legacy persisted refs (and
  // anything still hitting the lookup path from older contextBuffer state)
  // may carry the old prompt-visible `id=Fxxxx` prefix. Strip it here so
  // both attachment-fetching tools route the same ref through the adapter
  // callback — without this, `channel_fetch_attachment` would silently
  // succeed on a legacy ref while `look_at_channel_attachment` would fail.
  if (trimmed.startsWith('id=')) return trimmed.slice(3)
  return trimmed
}
