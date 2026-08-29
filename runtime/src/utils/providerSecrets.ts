import { BUILT_IN_PROVIDER_DEFINITIONS } from '../llm/registry/provider-info.js'

const NON_PROVIDER_SECRET_ENV_KEYS = [
  'OPENAI_AUTH_HEADER_VALUE',
  'ANTHROPIC_AUTH_TOKEN',
  'AGENC_API_KEY',
  'BNKR_API_KEY',
  'PROVIDER_CODE_API_KEY',
] as const

export const SECRET_ENV_KEYS: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(BUILT_IN_PROVIDER_DEFINITIONS).flatMap(definition =>
      definition.credentials.kind === 'api-key'
        ? definition.credentials.apiKey.envVars
        : [],
    ),
    ...NON_PROVIDER_SECRET_ENV_KEYS,
  ]),
])

export type SecretValueSource = Readonly<Record<string, string | undefined>>

export function sanitizeApiKey(
  key: string | null | undefined,
): string | undefined {
  if (!key || key === 'SUA_CHAVE') return undefined
  return key
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  if (trimmed.startsWith('sk-') || trimmed.startsWith('sk-ant-')) {
    return true
  }

  if (trimmed.startsWith('AIza')) {
    return true
  }

  return false
}

function collectSecretValues(
  sources: Array<SecretValueSource | null | undefined>,
): string[] {
  const values = new Set<string>()

  for (const source of sources) {
    if (!source) continue

    for (const key of SECRET_ENV_KEYS) {
      const value = sanitizeApiKey(source[key])
      if (value) {
        values.add(value)
      }
    }
  }

  return [...values]
}

export function maskSecretForDisplay(
  value: string | null | undefined,
): string | undefined {
  const sanitized = sanitizeApiKey(value)
  if (!sanitized) return undefined

  if (sanitized.length <= 8) {
    return 'configured'
  }

  return `${sanitized.slice(0, 3)}...${sanitized.slice(-3)}`
}

export function redactSecretValueForDisplay(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return trimmed

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return maskSecretForDisplay(trimmed) ?? 'configured'
  }

  return trimmed
}

export function sanitizeProviderConfigValue(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return undefined
  }

  return trimmed
}
