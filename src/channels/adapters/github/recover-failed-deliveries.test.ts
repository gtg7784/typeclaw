import { describe, expect, test } from 'bun:test'

import { createDeliveryDedup } from './dedup'
import {
  createRecoveredGuidLog,
  recoverFailedGithubDeliveries,
  type RecoverFailedDeliveriesOptions,
} from './recover-failed-deliveries'

const LOOKBACK_MS = 70 * 60 * 60 * 1000

type DeliveryFixture = {
  id: number
  guid: string
  event: string
  statusCode: number
  deliveredAt?: string
  payload?: Record<string, unknown>
}

type Routed = { event: string; delivery: string; payload: Record<string, unknown> }

const NOW = Date.parse('2026-06-16T12:00:00Z')

function listJson(fixtures: DeliveryFixture[]): Array<Record<string, unknown>> {
  return fixtures.map((d) => ({
    id: d.id,
    guid: d.guid,
    event: d.event,
    status_code: d.statusCode,
    delivered_at: d.deliveredAt ?? '2026-06-16T11:59:00Z',
  }))
}

// Serves the list + detail delivery endpoints for one or more hooks. `pages`
// lets a hook return multiple list pages via a Link: rel="next" header.
function fakeDeliveriesApi(input: {
  byHook: Record<number, DeliveryFixture[]>
  pages?: Record<number, DeliveryFixture[][]>
  listThrowsForHook?: number
}): { fetch: typeof fetch; detailFetches: number[] } {
  const detailFetches: number[] = []
  const fn = async (info: RequestInfo | URL): Promise<Response> => {
    const url = typeof info === 'string' ? info : info instanceof URL ? info.toString() : info.url
    const detail = url.match(/\/hooks\/(\d+)\/deliveries\/(\d+)(?:$|\?)/)
    if (detail) {
      const hookId = Number(detail[1])
      const deliveryId = Number(detail[2])
      detailFetches.push(deliveryId)
      const fixture = (input.byHook[hookId] ?? []).find((d) => d.id === deliveryId)
      return Response.json({ request: { payload: fixture?.payload ?? { recovered: deliveryId } } })
    }
    const list = url.match(/\/hooks\/(\d+)\/deliveries(?:$|\?)/)
    if (list) {
      const hookId = Number(list[1])
      if (input.listThrowsForHook === hookId) return new Response('boom', { status: 500 })
      const pages = input.pages?.[hookId]
      if (pages) {
        const cursorMatch = url.match(/cursor=(\d+)/)
        const pageIndex = cursorMatch ? Number(cursorMatch[1]) : 0
        const headers: Record<string, string> =
          pageIndex + 1 < pages.length
            ? {
                link: `<https://api.github.com/repos/acme/widgets/hooks/${hookId}/deliveries?cursor=${pageIndex + 1}>; rel="next"`,
              }
            : {}
        return Response.json(listJson(pages[pageIndex] ?? []), { headers })
      }
      return Response.json(listJson(input.byHook[hookId] ?? []))
    }
    return new Response('unexpected', { status: 500 })
  }
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, detailFetches }
}

function baseOptions(
  overrides: Partial<RecoverFailedDeliveriesOptions> & { routed: Routed[] },
): RecoverFailedDeliveriesOptions {
  const { routed, ...rest } = overrides
  return {
    hooks: [{ repo: 'acme/widgets', hookId: 1 }],
    token: async () => 'tok',
    process: async (input) => {
      routed.push(input)
    },
    alreadySeen: () => false,
    recoveredLog: createRecoveredGuidLog(LOOKBACK_MS, () => NOW),
    lookbackMs: LOOKBACK_MS,
    maxPerSweep: 50,
    logger: { info: () => {}, warn: () => {} },
    now: () => NOW,
    ...rest,
  }
}

describe('recoverFailedGithubDeliveries', () => {
  test('routes a failed delivery once, feeding the original event + payload through process', async () => {
    const routed: Routed[] = []
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-1', event: 'issue_comment', statusCode: 502, payload: { action: 'created' } }] },
    })

    const result = await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl }))

    expect(routed).toEqual([{ event: 'issue_comment', delivery: 'g-1', payload: { action: 'created' } }])
    expect(result.recovered).toBe(1)
  })

  test('does not re-route the same guid across sweeps (durable recoveredLog)', async () => {
    const routed: Routed[] = []
    const recoveredLog = createRecoveredGuidLog(LOOKBACK_MS, () => NOW)
    const { fetch: fetchImpl, detailFetches } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-1', event: 'issue_comment', statusCode: 0 }] },
    })

    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog }))
    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog }))

    expect(routed.length).toBe(1)
    expect(detailFetches).toEqual([11]) // second sweep skips before the detail fetch
  })

  test('skips a guid already seen by the live webhook path (race suppression, no detail fetch)', async () => {
    const routed: Routed[] = []
    const { fetch: fetchImpl, detailFetches } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-live', event: 'issue_comment', statusCode: 502 }] },
    })

    const result = await recoverFailedGithubDeliveries(
      baseOptions({ routed, fetchImpl, alreadySeen: (guid) => guid === 'g-live' }),
    )

    expect(routed).toEqual([])
    expect(detailFetches).toEqual([])
    expect(result.recovered).toBe(0)
  })

  test('skips a guid that also has a successful delivery (failed-then-redelivered-ok)', async () => {
    const routed: Routed[] = []
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: {
        1: [
          { id: 12, guid: 'g-ok', event: 'pull_request', statusCode: 200 },
          { id: 11, guid: 'g-ok', event: 'pull_request', statusCode: 502 },
        ],
      },
    })

    const result = await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl }))

    expect(routed).toEqual([])
    expect(result.recovered).toBe(0)
  })

  test('does not refetch a recovered no-op event on the next sweep', async () => {
    const routed: Routed[] = []
    const recoveredLog = createRecoveredGuidLog(LOOKBACK_MS, () => NOW)
    // A no-op classify (allowlist/self/null drop) still resolves `process`, so
    // the guid is recorded and the failed delivery is not refetched forever.
    const process = async () => {}
    const { fetch: fetchImpl, detailFetches } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-noop', event: 'issues', statusCode: 410 }] },
    })

    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog, process }))
    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog, process }))

    expect(detailFetches).toEqual([11])
  })

  test('does not re-route an old recovered delivery after the live dedup evicts its guid', async () => {
    const routed: Routed[] = []
    const dedup = createDeliveryDedup() // the real 1000-entry LRU
    const recoveredLog = createRecoveredGuidLog(LOOKBACK_MS, () => NOW)
    // Mirror production: the live core reserves the guid in the shared dedup.
    const process = async (i: Routed) => {
      dedup.add(i.delivery)
      routed.push(i)
    }
    const alreadySeen = (g: string) => dedup.has(g)
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-old', event: 'issue_comment', statusCode: 502 }] },
    })

    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog, process, alreadySeen }))
    expect(routed.length).toBe(1)

    // Flood the live dedup past its 1000-entry cap so g-old is evicted.
    for (let i = 0; i < 1100; i++) dedup.add(`flood-${i}`)
    expect(dedup.has('g-old')).toBe(false)

    // g-old is still in the delivery log and gone from the live dedup, but the
    // durable recoveredLog remembers it for the lookback window → not re-routed.
    await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, recoveredLog, process, alreadySeen }))
    expect(routed.length).toBe(1)
  })

  test('isolates a per-hook list failure: other hooks still recover', async () => {
    const routed: Routed[] = []
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: {
        1: [{ id: 11, guid: 'g-a', event: 'issue_comment', statusCode: 502 }],
        2: [{ id: 21, guid: 'g-b', event: 'issue_comment', statusCode: 502 }],
      },
      listThrowsForHook: 1,
    })

    const result = await recoverFailedGithubDeliveries(
      baseOptions({
        routed,
        fetchImpl,
        hooks: [
          { repo: 'acme/widgets', hookId: 1 },
          { repo: 'acme/gadgets', hookId: 2 },
        ],
      }),
    )

    expect(routed.map((r) => r.delivery)).toEqual(['g-b'])
    expect(result.recovered).toBe(1)
  })

  test('skips deliveries older than the lookback window', async () => {
    const routed: Routed[] = []
    const old = new Date(NOW - 100 * 60 * 60 * 1000).toISOString()
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: { 1: [{ id: 11, guid: 'g-old', event: 'issue_comment', statusCode: 502, deliveredAt: old }] },
    })

    const result = await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl }))

    expect(routed).toEqual([])
    expect(result.recovered).toBe(0)
  })

  test('caps recoveries per sweep', async () => {
    const routed: Routed[] = []
    const fixtures: DeliveryFixture[] = Array.from({ length: 5 }, (_, i) => ({
      id: 10 + i,
      guid: `g-${i}`,
      event: 'issue_comment',
      statusCode: 502,
    }))
    const { fetch: fetchImpl } = fakeDeliveriesApi({ byHook: { 1: fixtures } })

    const result = await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl, maxPerSweep: 2 }))

    expect(result.recovered).toBe(2)
    expect(routed.length).toBe(2)
  })

  test('caps recoveries GLOBALLY across hooks, not per hook', async () => {
    const routed: Routed[] = []
    const fixturesFor = (base: number): DeliveryFixture[] =>
      Array.from({ length: 3 }, (_, i) => ({
        id: base + i,
        guid: `g-${base + i}`,
        event: 'issue_comment',
        statusCode: 502,
      }))
    const { fetch: fetchImpl } = fakeDeliveriesApi({ byHook: { 1: fixturesFor(10), 2: fixturesFor(20) } })

    const result = await recoverFailedGithubDeliveries(
      baseOptions({
        routed,
        fetchImpl,
        maxPerSweep: 4,
        hooks: [
          { repo: 'acme/widgets', hookId: 1 },
          { repo: 'acme/gadgets', hookId: 2 },
        ],
      }),
    )

    expect(result.recovered).toBe(4) // 3 from hook 1 + 1 from hook 2, not 3 + 3
    expect(routed.length).toBe(4)
  })

  test('paginates the delivery log via the Link header', async () => {
    const routed: Routed[] = []
    const { fetch: fetchImpl } = fakeDeliveriesApi({
      byHook: { 1: [] },
      pages: {
        1: [
          [{ id: 11, guid: 'g-page1', event: 'issue_comment', statusCode: 502 }],
          [{ id: 21, guid: 'g-page2', event: 'issue_comment', statusCode: 502 }],
        ],
      },
    })

    const result = await recoverFailedGithubDeliveries(baseOptions({ routed, fetchImpl }))

    expect(routed.map((r) => r.delivery).sort()).toEqual(['g-page1', 'g-page2'])
    expect(result.recovered).toBe(2)
  })
})

describe('createRecoveredGuidLog', () => {
  test('remembers a guid within the TTL and forgets it once the TTL elapses', () => {
    let nowMs = 1_000
    const log = createRecoveredGuidLog(100, () => nowMs)

    log.record('g') // recorded at 1000 → expires at 1100
    expect(log.has('g')).toBe(true)

    nowMs += 99 // 1099, still before expiry
    expect(log.has('g')).toBe(true)

    nowMs += 1 // 1100, expiry reached (expiry <= now ⇒ expired)
    expect(log.has('g')).toBe(false)
  })
})
