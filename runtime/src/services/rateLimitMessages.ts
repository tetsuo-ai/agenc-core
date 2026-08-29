const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}
