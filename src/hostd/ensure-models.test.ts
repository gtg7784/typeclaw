import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type PipelineCall = { model: string; options: Record<string, unknown> | undefined }

const pipelineCalls: PipelineCall[] = []
let releasePipeline: (() => void) | null = null

mock.module('@huggingface/transformers', () => ({
  env: {},
  pipeline: async (_task: string, model: string, options?: Record<string, unknown>) => {
    pipelineCalls.push({ model, options })
    await new Promise<void>((resolve) => {
      releasePipeline = resolve
    })
    return () => undefined
  },
}))

describe('ensureModels', () => {
  const originalHome = process.env.TYPECLAW_HOME
  const home = join(tmpdir(), `typeclaw-models-${crypto.randomUUID()}`)

  beforeAll(async () => {
    process.env.TYPECLAW_HOME = home
    await mkdir(home, { recursive: true })
  })

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.TYPECLAW_HOME
    else process.env.TYPECLAW_HOME = originalHome
    await rm(home, { recursive: true, force: true })
  })

  test('concurrent callers share one model provisioning call', async () => {
    const { ensureModels } = await import('./models')

    const callers = Array.from({ length: 8 }, () => ensureModels())
    await waitFor(() => pipelineCalls.length === 1)
    releasePipeline?.()
    await Promise.all(callers)

    const { modelsDir } = await import('./paths')

    expect(pipelineCalls.map((call) => call.model)).toEqual(['Xenova/multilingual-e5-base'])
    expect((await stat(modelsDir())).isDirectory()).toBe(true)
  })

  test('downloads the q8 (quantized) variant, not the fp32 default', async () => {
    expect(pipelineCalls).toHaveLength(1)
    expect(pipelineCalls[0]?.options?.dtype).toBe('q8')
  })

  test('stamps a model-cache sentinel after the download so the container can verify producer/consumer compatibility', async () => {
    const { modelsDir } = await import('./paths')
    const { readModelSentinel } = await import('@/models/embedding-model')

    const sentinel = await readModelSentinel(modelsDir())
    expect(sentinel).not.toBeNull()
    expect(sentinel?.model).toBe('Xenova/multilingual-e5-base')
    expect(sentinel?.dtype).toBe('q8')
    expect(sentinel?.transformers).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('modelsDir points under TYPECLAW_HOME', async () => {
    const { modelsDir } = await import('./paths')

    expect(modelsDir()).toBe(join(home, 'models'))
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('timed out waiting for condition')
}
