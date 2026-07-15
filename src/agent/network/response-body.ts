export async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`invalid response byte limit: ${maxBytes}`)
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) throw responseTooLarge(declared, maxBytes)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw responseTooLarge(total, maxBytes)
      chunks.push(next.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function responseTooLarge(size: number, maxBytes: number): Error {
  return new Error(`response is too large (${size} bytes > ${maxBytes} byte limit)`)
}
