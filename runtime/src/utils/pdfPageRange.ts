export type PDFPageRange = {
  readonly firstPage: number
  readonly lastPage: number
}

/**
 * Parse a 1-indexed PDF page range string.
 *
 * Supported formats:
 * - "5" -> { firstPage: 5, lastPage: 5 }
 * - "1-10" -> { firstPage: 1, lastPage: 10 }
 * - "3-" -> { firstPage: 3, lastPage: Infinity }
 */
export function parsePDFPageRange(pages: string): PDFPageRange | null {
  const trimmed = pages.trim()
  if (!trimmed) {
    return null
  }

  const openEnded = /^([1-9]\d*)-$/u.exec(trimmed)
  if (openEnded) {
    return {
      firstPage: Number.parseInt(openEnded[1]!, 10),
      lastPage: Infinity,
    }
  }

  const singlePage = /^([1-9]\d*)$/u.exec(trimmed)
  if (singlePage) {
    const page = Number.parseInt(singlePage[1]!, 10)
    return { firstPage: page, lastPage: page }
  }

  const closedRange = /^([1-9]\d*)-([1-9]\d*)$/u.exec(trimmed)
  if (closedRange) {
    const first = Number.parseInt(closedRange[1]!, 10)
    const last = Number.parseInt(closedRange[2]!, 10)
    return last < first ? null : { firstPage: first, lastPage: last }
  }

  return null
}
