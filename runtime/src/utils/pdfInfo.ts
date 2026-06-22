export function parsePDFInfoPageCount(stdout: string): number | null {
  const match = /^Pages:\s+(\d+)/mu.exec(stdout)
  if (!match) return null
  const count = Number.parseInt(match[1]!, 10)
  return Number.isFinite(count) && count > 0 ? count : null
}
