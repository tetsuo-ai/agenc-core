import { describe, expect, test } from 'vitest'

import { readBodyCapped } from '../../../src/tools/WebFetchTool/utils.ts'

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream)
}

describe('readBodyCapped', () => {
  test('returns the full body when under the cap', async () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    const out = await readBodyCapped(streamResponse([a, b]))
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  test('returns empty for a null body', async () => {
    const out = await readBodyCapped(new Response(null))
    expect(out.byteLength).toBe(0)
  })

  test('throws once the streamed total exceeds the 10MB cap', async () => {
    // Eleven 1MB chunks = 11MB > MAX_HTTP_CONTENT_LENGTH (10MB). A hostile
    // server could omit Content-Length, so the cap must be enforced while
    // streaming, not from the header.
    const oneMB = new Uint8Array(1024 * 1024)
    const chunks = Array.from({ length: 11 }, () => oneMB)
    await expect(readBodyCapped(streamResponse(chunks))).rejects.toThrow(
      /maxContentLength/,
    )
  })
})
