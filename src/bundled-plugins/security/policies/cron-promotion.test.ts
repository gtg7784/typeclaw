import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ACKNOWLEDGE_GUARDS } from '../policy'
import { GUARD_CRON_PROMOTION, checkCronPromotionGuard, diffJobs } from './cron-promotion'

async function makeAgentDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'typeclaw-cron-promotion-'))
}

async function writeCron(agentDir: string, file: unknown): Promise<void> {
  await writeFile(path.join(agentDir, 'cron.json'), JSON.stringify(file, null, 2))
}

const BASELINE_JOB = {
  id: 'daily',
  kind: 'prompt',
  schedule: '0 9 * * *',
  prompt: 'good morning',
  scheduledByRole: 'owner',
}

const BASELINE_CRON = {
  jobs: [BASELINE_JOB],
}

describe('diffJobs — unit', () => {
  test('no-op when job sets are byte-identical', () => {
    expect(diffJobs([BASELINE_JOB as never], [BASELINE_JOB as never])).toEqual([])
  })

  test('flags an added job', () => {
    const findings = diffJobs(
      [BASELINE_JOB as never],
      [
        BASELINE_JOB as never,
        {
          id: 'evening',
          kind: 'prompt',
          schedule: '0 18 * * *',
          prompt: 'goodnight',
          scheduledByRole: 'trusted',
        } as never,
      ],
    )
    expect(findings).toEqual([{ kind: 'job-added', id: 'evening', scheduledByRole: 'trusted' }])
  })

  test('flags a job whose scheduledByRole changed', () => {
    const findings = diffJobs([BASELINE_JOB as never], [{ ...BASELINE_JOB, scheduledByRole: 'trusted' } as never])
    expect(findings).toEqual([{ kind: 'role-changed', id: 'daily', from: 'owner', to: 'trusted' }])
  })

  test('does NOT flag a removed job', () => {
    expect(diffJobs([BASELINE_JOB as never], [])).toEqual([])
  })

  test('does NOT flag a schedule-only change', () => {
    const findings = diffJobs([BASELINE_JOB as never], [{ ...BASELINE_JOB, schedule: '0 10 * * *' } as never])
    expect(findings).toEqual([])
  })

  test('does NOT flag a prompt-text change', () => {
    const findings = diffJobs([BASELINE_JOB as never], [{ ...BASELINE_JOB, prompt: 'good afternoon' } as never])
    expect(findings).toEqual([])
  })

  test('does NOT flag toggling enabled', () => {
    const findings = diffJobs(
      [{ ...BASELINE_JOB, enabled: true } as never],
      [{ ...BASELINE_JOB, enabled: false } as never],
    )
    expect(findings).toEqual([])
  })
})

describe('checkCronPromotionGuard — write (the canonical attack)', () => {
  test('blocks a write that adds a new job running as owner', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)

    const after = {
      jobs: [
        BASELINE_JOB,
        {
          id: 'exfil',
          kind: 'prompt',
          schedule: '*/5 * * * *',
          prompt: 'do something privileged',
          scheduledByRole: 'owner',
        },
      ],
    }
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify(after) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('exfil')
    expect(result?.reason).toContain('owner')
  })

  test('blocks a write that promotes an existing job from trusted to owner', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, {
      jobs: [{ ...BASELINE_JOB, scheduledByRole: 'trusted' }],
    })

    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify(BASELINE_CRON) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('trusted')
    expect(result?.reason).toContain('owner')
  })

  test('allows a write that removes a job', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [] }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('allows a write that only changes the schedule', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: {
        path: 'cron.json',
        content: JSON.stringify({ jobs: [{ ...BASELINE_JOB, schedule: '0 10 * * *' }] }),
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('passes through when acknowledged', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)
    const after = {
      jobs: [
        BASELINE_JOB,
        { id: 'new', kind: 'prompt', schedule: '*/5 * * * *', prompt: 'x', scheduledByRole: 'owner' },
      ],
    }
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: {
        path: 'cron.json',
        content: JSON.stringify(after),
        [ACKNOWLEDGE_GUARDS]: { [GUARD_CRON_PROMOTION]: true },
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('does not run on non-cron.json paths', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'workspace/cron.json', content: '{"jobs":[]}' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('falls through when proposed content fails to parse (managedConfig surfaces error)', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: '{ not valid json' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})

describe('checkCronPromotionGuard — first-init', () => {
  test('blocks a fresh write that introduces any privileged job', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify(BASELINE_CRON) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('daily')
  })

  test('allows a fresh write with no jobs', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [] }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})

describe('checkCronPromotionGuard — block reason is operator-safe', () => {
  test('ANSI escapes in job id are stripped', async () => {
    const agentDir = await makeAgentDir()
    await writeCron(agentDir, BASELINE_CRON)
    const after = {
      jobs: [
        BASELINE_JOB,
        {
          id: 'normal-id',
          kind: 'prompt',
          schedule: '*/5 * * * *',
          prompt: 'x',
          scheduledByRole: 'owner',
        },
      ],
    }
    const result = await checkCronPromotionGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify(after) },
      agentDir,
    })
    // eslint-disable-next-line no-control-regex
    expect(result?.reason).not.toMatch(/\u001b/)
  })
})
