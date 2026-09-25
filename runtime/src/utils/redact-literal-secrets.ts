/**
 * Core serializes some diagnostics as JSON before they are logged (header
 * maps, error payloads), which escapes quotes, backslashes and control
 * characters. Match those escaped copies too, one and two levels deep.
 */
function withSerializedForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>()
  for (const secret of secrets) {
    if (secret.length === 0) continue
    forms.add(secret)
    const once = JSON.stringify(secret).slice(1, -1)
    forms.add(once)
    forms.add(JSON.stringify(once).slice(1, -1))
  }
  return [...forms]
}

/**
 * The union of every literal match in the text, as sorted, disjoint
 * [start, end) intervals. Matches that begin inside an earlier match join it,
 * including matches connected through several literals.
 */
function literalMatchIntervals(text: string, literals: readonly string[]): Array<[number, number]> {
  const next = literals.map(literal => text.indexOf(literal))
  const intervals: Array<[number, number]> = []
  for (;;) {
    let start = text.length
    for (const at of next) if (at >= 0 && at < start) start = at
    if (start === text.length) return intervals

    let end = start
    for (;;) {
      let advanced = false
      for (let i = 0; i < literals.length; i++) {
        while (next[i]! >= 0 && next[i]! <= end) {
          const at = next[i]!
          end = Math.max(end, at + literals[i]!.length)
          next[i] = text.indexOf(literals[i]!, at + 1)
          advanced = true
        }
      }
      if (!advanced) break
    }
    intervals.push([start, end])
  }
}

/** Redact the union of every literal match in the original text. */
export function redactLiteralSecrets(text: string, secrets: readonly string[]): string {
  let result = ''
  let offset = 0
  for (const [start, end] of literalMatchIntervals(text, withSerializedForms(secrets))) {
    result += text.slice(offset, start) + '[REDACTED]'
    offset = end
  }
  return result + text.slice(offset)
}

/**
 * Split stream text into a part that is safe to redact and emit now, and a
 * pending tail to prepend to the next chunk. The tail is the longest suffix of
 * the original text that could still grow into a secret (in any matched
 * form), so a longer secret is held even when a shorter one already matches
 * there. A complete match that crosses the cut is held whole.
 */
export function redactLiteralSecretsHoldingPrefix(
  text: string,
  secrets: readonly string[],
): { redacted: string; pending: string } {
  const literals = withSerializedForms(secrets)
  let pendingLength = 0
  for (const literal of literals) {
    for (let length = Math.min(literal.length - 1, text.length); length > pendingLength; length--) {
      if (text.endsWith(literal.slice(0, length))) {
        pendingLength = length
        break
      }
    }
  }
  let cut = text.length - pendingLength
  for (const [start, end] of literalMatchIntervals(text, literals)) {
    if (start < cut && cut < end) {
      cut = start
      break
    }
  }
  return {
    redacted: redactLiteralSecrets(text.slice(0, cut), secrets),
    pending: text.slice(cut),
  }
}
