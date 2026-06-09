import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'

import { printLineQrUrl } from './channel'

function captureStream(): { stream: Writable; written: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return { stream, written: () => chunks.join('') }
}

describe('printLineQrUrl', () => {
  const url = 'https://line.me/R/au/lgn/sq/aBcDeFgHiJ?secret=Zm9vYmFyL21lL3NlY3JldA%3D%3D&e2eeVersion=1'

  test('writes the URL to the stream verbatim on its own line so it stays copyable', () => {
    // given
    const { stream, written } = captureStream()

    // when
    printLineQrUrl(url, stream)

    // then: the raw URL is emitted intact (no box border `│` splicing it apart)
    expect(written()).toContain(`${url}\n`)
    expect(written()).not.toContain('│')
  })
})
