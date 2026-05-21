import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_ENTRY = join(import.meta.dir, 'index.ts')

describe('typeclaw role list survives broken typeclaw.json', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-role-list-broken-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runRoleList(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'role', 'list'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  test('exits 0 and prints the empty-roles hint when typeclaw.json is malformed JSON', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), 'NOT JSON AT ALL {{{')
    const { exitCode, stdout, stderr } = await runRoleList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No roles declared')
    expect(stderr).toMatch(/not valid JSON/)
    expect(stderr).toMatch(/diagnostic commands still work/)
  })

  test('exits 0 and prints the empty-roles hint when typeclaw.json is schema-invalid', async () => {
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const { exitCode, stdout, stderr } = await runRoleList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No roles declared')
    expect(stderr).toMatch(/typeclaw\.json is invalid/)
  })

  test('exits 0 and renders declared roles when typeclaw.json is valid', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({
        roles: {
          member: { match: ['slack:T0123'] },
        },
      }),
    )
    const { exitCode, stdout, stderr } = await runRoleList()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('member')
    expect(stdout).toContain('slack')
    expect(stderr).not.toMatch(/warning:/)
  })
})
