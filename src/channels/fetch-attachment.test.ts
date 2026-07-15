import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { readAttachmentResponse } from './fetch-attachment'

describe('bounded attachment response reader', () => {
  test('fails before reading a declared oversized body and cancels it', async () => {
    let pulled = false
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true
        controller.enqueue(new Uint8Array([1]))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(body, { headers: { 'content-length': '11' } })
    await expect(readAttachmentResponse(response, 10)).rejects.toThrow(/too large/)
    expect(pulled).toBeFalse()
    expect(cancelled).toBeTrue()
  })

  test('stops and cancels a streaming body as soon as the cap is crossed', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6))
        controller.enqueue(new Uint8Array(6))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readAttachmentResponse(new Response(body), 10)).rejects.toThrow(/too large/)
    expect(cancelled).toBeTrue()
  })
})

describe('FetchAttachmentCallback adapter contract guard', () => {
  test('every registered download-capable adapter wires the shared byte limit into bounded handling', async () => {
    const implementations = [
      ['discord.ts', 'readAttachmentResponse'],
      ['discord-bot.ts', 'readAttachmentResponse'],
      ['telegram-bot.ts', 'readAttachmentResponse'],
      ['webex.ts', 'readAttachmentResponse'],
      ['webex-bot.ts', 'readAttachmentResponse'],
      ['kakaotalk-fetch-attachment.ts', 'readAttachmentResponse'],
      ['slack.ts', 'enforceAttachmentMetadataSize'],
      ['slack-bot.ts', 'enforceAttachmentMetadataSize'],
    ] as const
    for (const [filename, enforcement] of implementations) {
      const source = await readFile(path.join(import.meta.dir, 'adapters', filename), 'utf8')
      expect(source).toContain('maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES')
      expect(source).toContain(enforcement)
    }
  })
})
