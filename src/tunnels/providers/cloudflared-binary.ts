// Bun.spawn throws synchronously with `code === 'ENOENT'` when the binary is
// absent from $PATH. Both Cloudflare providers translate that into a
// permanently-failed state instead of letting the raw spawn error bubble up
// as a generic "start failed" log — the actionable fix is enabling
// docker.file.cloudflared and rebuilding, not waiting through restart backoff.
export const MISSING_BINARY_DETAIL =
  'cloudflared binary not found in image; set docker.file.cloudflared: true in typeclaw.json and run typeclaw restart'

export function isBinaryNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}
