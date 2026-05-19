export function parseToolListFromCLI(tools: string[]): string[] {
  if (tools.length === 0) {
    return []
  }

  const result: string[] = []

  for (const toolString of tools) {
    if (!toolString) continue

    let current = ''
    let isInParens = false

    for (const char of toolString) {
      switch (char) {
        case '(':
          isInParens = true
          current += char
          break
        case ')':
          isInParens = false
          current += char
          break
        case ',':
          if (isInParens) {
            current += char
          } else {
            if (current.trim()) {
              result.push(current.trim())
            }
            current = ''
          }
          break
        case ' ':
          if (isInParens) {
            current += char
          } else if (current.trim()) {
            result.push(current.trim())
            current = ''
          }
          break
        default:
          current += char
      }
    }

    if (current.trim()) {
      result.push(current.trim())
    }
  }

  return result
}
