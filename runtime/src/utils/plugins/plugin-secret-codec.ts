export const ARRAY_SECRET_PREFIX = 'agenc:array:v1:'
export const SCALAR_SECRET_PREFIX = 'agenc:scalar:v1:'
export const TYPED_SECRET_PREFIX = 'agenc:value:v1:'
export const SECRET_ENVELOPE_PREFIX = 'agenc:secret:v2:'
export type PluginSecretFormat = 'literal-v1' | 'typed-v1' | `typed-v2:${string}`

/** Keep the credential payload readable by the base build, which uses String(value). */
export function encodeStoredPluginSecret(value: string | number | boolean | string[], field?: { readonly multiple?: boolean }): string {
  void field
  return String(value)
}

export function pluginSecretFormat(value: string | number | boolean | string[], field?: { readonly multiple?: boolean }): PluginSecretFormat {
  return Array.isArray(value) || field?.multiple === true ? `typed-v2:${JSON.stringify(value)}` : 'literal-v1'
}

function parsedValue(stored: string, prefix: string): unknown {
  try { return JSON.parse(stored.slice(prefix.length)) }
  catch { return undefined }
}

/** Decode the same secure-storage formats used by plugin substitution and redaction. */
export function decodeStoredPluginSecret(
  stored: string,
  field?: { readonly type?: string; readonly multiple?: boolean },
  format?: PluginSecretFormat,
): string | number | boolean | string[] {
  if (format?.startsWith('typed-v2:')) {
    const parsed = parsedValue(format, 'typed-v2:')
    if ((typeof parsed === 'string' || typeof parsed === 'number' && Number.isFinite(parsed) ||
         typeof parsed === 'boolean' || Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) &&
        String(parsed) === stored) return parsed
  }
  // Prefixes are meaningful only for records explicitly marked as typed-v1.
  // An unmarked legacy credential can start with any reserved prefix.
  if (format === 'typed-v1') {
    if (stored.startsWith(TYPED_SECRET_PREFIX)) {
      const parsed = parsedValue(stored, TYPED_SECRET_PREFIX)
      if (typeof parsed === 'string' || typeof parsed === 'number' && Number.isFinite(parsed) ||
          typeof parsed === 'boolean' || Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
    }
    if (stored.startsWith(SCALAR_SECRET_PREFIX)) {
      const parsed = parsedValue(stored, SCALAR_SECRET_PREFIX)
      if (typeof parsed === 'string') return parsed
    }
    if (stored.startsWith(ARRAY_SECRET_PREFIX)) {
      const parsed = parsedValue(stored, ARRAY_SECRET_PREFIX)
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
    }
  }
  if (field?.type === 'number' && stored !== '' && Number.isFinite(Number(stored))) return Number(stored)
  if (field?.type === 'boolean' && (stored === 'true' || stored === 'false')) return stored === 'true'
  return stored
}

export function storedPluginSecretStrings(stored: string, format?: PluginSecretFormat): readonly string[] {
  // Existing unmarked values stay literal for projections. The format lives
  // beside the credential, so prefix-looking literal values remain literal.
  if (format === undefined || format === 'literal-v1') return [stored]
  const decoded = decodeStoredPluginSecret(stored, undefined, format)
  return [stored, ...(Array.isArray(decoded) ? decoded : [String(decoded)])]
}
