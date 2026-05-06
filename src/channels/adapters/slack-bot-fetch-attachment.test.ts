import { describe, expect, test } from 'bun:test'

import { createFetchAttachmentCallback, type SlackBotAdapterLogger } from './slack-bot'

function silentLogger(): SlackBotAdapterLogger & { errors: string[] } {
  const errors: string[] = []
  return {
    info: () => {},
    warn: () => {},
    error: (m) => {
      errors.push(m)
    },
    errors,
  }
}

describe('slack-bot createFetchAttachmentCallback', () => {
  test('hands a valid Fxxxx file id to the SDK and surfaces the buffer + metadata to the router', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      client: {
        downloadFile: async (fileId) => ({
          buffer: Buffer.from(`bytes-for-${fileId}`),
          file: {
            id: fileId,
            name: 'diagram.png',
            title: 'diagram',
            mimetype: 'image/png',
            size: 17,
            url_private: 'https://files.slack.com/.../diagram.png',
            created: 1700000000,
            user: 'UALICE',
          },
        }),
      },
      logger,
    })

    const result = await cb({ ref: 'F12345' })

    expect(result).toEqual({
      ok: true,
      buffer: Buffer.from('bytes-for-F12345'),
      filename: 'diagram.png',
      mimetype: 'image/png',
      size: 17,
    })
    expect(logger.errors).toEqual([])
  })

  test('respects an explicit filename override (lets the agent rename inflight)', async () => {
    const cb = createFetchAttachmentCallback({
      client: {
        downloadFile: async () => ({
          buffer: Buffer.from('x'),
          file: {
            id: 'F1',
            name: 'upstream.png',
            title: 'u',
            mimetype: 'image/png',
            size: 1,
            url_private: 'https://files.slack.com/.../upstream.png',
            created: 1700000000,
            user: 'UALICE',
          },
        }),
      },
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'F1', filename: 'renamed.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.filename).toBe('renamed.png')
  })

  test('rejects refs that are not Slack file ids without calling the SDK (prevents url leakage)', async () => {
    let downloadCalled = false
    const cb = createFetchAttachmentCallback({
      client: {
        downloadFile: async () => {
          downloadCalled = true
          throw new Error('should not be called')
        },
      },
      logger: silentLogger(),
    })

    const result = await cb({ ref: 'https://files.slack.com/private/F1/diagram.png' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('invalid Slack file id')
    expect(downloadCalled).toBe(false)
  })

  test('returns a structured error when the SDK download throws', async () => {
    const logger = silentLogger()
    const cb = createFetchAttachmentCallback({
      client: {
        downloadFile: async () => {
          throw new Error('files.info: file_not_found')
        },
      },
      logger,
    })

    const result = await cb({ ref: 'F404' })

    expect(result).toEqual({ ok: false, error: 'files.info: file_not_found' })
    expect(logger.errors[0]).toContain('downloadFile failed for F404')
  })
})
