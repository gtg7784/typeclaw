import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'
import {
  __resetForwardRequestBus,
  __resetForwardResultBus,
  publishForwardResult,
  subscribeForwardRequest,
} from '@/portbroker'
import { waitFor } from '@/test-helpers/wait-for'

import agentBrowserPlugin, { __resetForwardRequestForTesting } from './index'

// Per-worker hint path: `bun test --parallel` runs many worker processes on one
// host, and the plugin's default hint path is a single shared /tmp file. A
// unique path per process stops workers from clobbering each other's hint.
const HINT_PATH = join(tmpdir(), `typeclaw-agent-browser-proxy-port-${process.pid}-${randomUUID()}`)
process.env['TYPECLAW_AGENT_BROWSER_PROXY_PORT_HINT_PATH'] = HINT_PATH

afterEach(() => {
  __resetForwardRequestForTesting()
  __resetForwardRequestBus()
  __resetForwardResultBus()
  delete process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  rmSync(HINT_PATH, { force: true })
})

afterAll(() => {
  delete process.env['TYPECLAW_AGENT_BROWSER_PROXY_PORT_HINT_PATH']
})

describe('agent-browser plugin', () => {
  test('factory returns immediately, exports the skill directory, and no hooks/tools', async () => {
    process.env['TYPECLAW_HOSTD_BROKER_TOKEN'] = 'tok'

    const exports = await bootPlugin('/agent')

    expect((exports.skillsDirs ?? []).map((dir) => dir.split(sep).join('/'))).toEqual([
      expect.stringContaining('bundled-plugins/agent-browser/skills'),
    ])
    expect(exports.tools).toBeUndefined()
    expect(exports.hooks).toBeUndefined()
  })

  test('publishes a reserved forward request and records the won host port from the result bus', async () => {
    process.env['TYPECLAW_HOSTD_BROKER_TOKEN'] = 'tok'
    const requests: unknown[] = []
    subscribeForwardRequest((event) => requests.push(event))

    await bootPlugin('/agent')
    publishForwardResult({ port: 4848, ok: true, hostPort: 4851 })

    await waitFor(() => readHint() === '4851')
    expect(requests).toEqual([
      {
        targetPort: 4848,
        hostCandidates: [4848, 4849, 4850, 4851, 4852, 4853, 4854, 4855, 4856, 4857],
        reason: 'agent-browser-dashboard',
      },
    ])
  })

  test('broker-disabled writes a diagnostic instead of a confident port', async () => {
    await bootPlugin('/agent')

    await waitFor(() => readHint().includes('broker is disabled'))
    expect(readHint()).not.toBe('4848')
  })

  test('forward failure writes a diagnostic instead of a confident port', async () => {
    process.env['TYPECLAW_HOSTD_BROKER_TOKEN'] = 'tok'
    await bootPlugin('/agent')

    publishForwardResult({ port: 4848, ok: false, reason: 'EADDRINUSE' })

    await waitFor(() => readHint().includes('unavailable'))
    expect(readHint()).not.toBe('4848')
  })
})

async function bootPlugin(agentDir: string) {
  return agentBrowserPlugin.plugin(
    createPluginContext({
      name: 'agent-browser',
      version: undefined,
      agentDir,
      config: undefined,
      logger: createPluginLogger('agent-browser'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    }),
  )
}

function readHint(): string {
  try {
    return readFileSync(HINT_PATH, 'utf8')
  } catch {
    return ''
  }
}
