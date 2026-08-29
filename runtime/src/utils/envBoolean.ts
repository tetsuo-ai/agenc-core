/** Parse the accepted boolean spellings used by environment ingress. */
export function isEnvTruthy(
  value: string | boolean | undefined,
): boolean {
  if (!value) return false
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

export function isEnvDefinedFalsy(
  value: string | boolean | undefined,
): boolean {
  if (value === undefined || typeof value === 'boolean') return value === false
  if (!value) return false
  return ['0', 'false', 'no', 'off'].includes(value.toLowerCase().trim())
}
