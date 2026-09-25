import type { HomeContext } from '../config/home.js'
import { readNativeSecureStorage } from '../utils/secureStorage/native.js'
import { storedPluginSecretStrings } from '../utils/plugins/plugin-secret-codec.js'
import { redactLiteralSecrets } from '../utils/redact-literal-secrets.js'

/** Snapshot current secret values once for an outward-facing MCP projection. */
export function createSavedPluginSecretRedactor(home: HomeContext): (value: string) => string {
  let storage: ReturnType<typeof readNativeSecureStorage>
  try {
    storage = readNativeSecureStorage(home)
  } catch {
    return () => '[REDACTED]'
  }
  const secrets = new Set<string>()
  for (const [bucketName, bucket] of Object.entries(storage.pluginSecrets ?? {})) {
    for (const [key, stored] of Object.entries(bucket)) {
      if (!stored) continue
      storedPluginSecretStrings(stored, storage.pluginSecretFormats?.[bucketName]?.[key]).forEach(secret => secrets.add(secret))
    }
  }
  const ordered = [...secrets].filter(secret => secret.length >= 4)
  return value => redactLiteralSecrets(value, ordered)
}

export function redactSavedPluginSecrets(value: string, home: HomeContext): string {
  return createSavedPluginSecretRedactor(home)(value)
}
