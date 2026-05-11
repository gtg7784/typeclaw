export type InstallResult = { ok: true } | { ok: false; reason: string }

export async function runBunInstall(cwd: string): Promise<InstallResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }
  try {
    const proc = bun.spawn({
      cmd: ['bun', 'install'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code === 0) return { ok: true }
    const stderr = await new Response(proc.stderr).text()
    return { ok: false, reason: `bun install exited with code ${code}: ${stderr.trim() || 'no stderr'}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
