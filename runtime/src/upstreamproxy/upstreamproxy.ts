/**
 * Validate that a string contains only well-formed PEM certificate blocks.
 * Used before appending a remotely downloaded CA certificate to a subprocess
 * trust bundle.
 */
export function isValidPemContent(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  const pemBlockPattern =
    '-----BEGIN CERTIFICATE-----\\s+[A-Za-z0-9+/=\\r\\n]+-----END CERTIFICATE-----'
  return new RegExp(`^(?:${pemBlockPattern}\\s*)+$`).test(trimmed)
}
