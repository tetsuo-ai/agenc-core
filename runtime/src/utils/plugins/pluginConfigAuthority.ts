import type { HomeContext } from '../../config/home.js'
import type { AgenCConfig } from '../../config/schema.js'
import { readCanonicalUserConfigSnapshotSync } from '../../config/update-sync.js'
import type { SecureStorageData } from '../secureStorage/index.js'
import {
  NativeSecureStorageError,
  rollbackNativeSecureStorage,
  type NativeSecureStorageTransaction,
} from '../secureStorage/native.js'
import {
  getCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from '../settings/canonicalAuthority.js'

export type PluginConfigStoredValue =
  | string
  | number
  | boolean
  | readonly string[]

export type PluginConfigSensitivitySchema = Readonly<
  Record<string, { readonly sensitive?: boolean }>
>

/**
 * Raised when a field declared sensitive by the installed plugin manifest is
 * found in config.toml. The error deliberately reports keys, never values.
 */
export class PlaintextPluginSecretError extends Error {
  readonly name = 'PlaintextPluginSecretError'
  readonly fields: readonly string[]

  constructor(location: string, fields: readonly string[]) {
    const sorted = Object.freeze([...fields].sort())
    super(
      `${location} contains sensitive field(s) in config.toml: ${sorted.join(', ')}. ` +
        'AgenC did not load those values. Reconfigure the plugin from /plugin so ' +
        'the native secure storage becomes the sole secret owner and the ' +
        'plaintext fields are scrubbed, or remove them from config.toml.',
    )
    this.fields = sorted
  }
}

/** Bind plugin config and secure-storage access to the current immutable ConfigStore. */
export function requirePluginConfigAuthority(): CanonicalSettingsAuthority {
  const authority = getCanonicalSettingsAuthority()
  if (authority === null) {
    throw new Error(
      'Plugin option storage requires a canonical ConfigStore authority',
    )
  }
  return authority
}

/** Read plugin preferences from the current canonical document without publishing a store reload. */
export function readFreshPluginConfigs(): AgenCConfig['pluginConfigs'] {
  const authority = requirePluginConfigAuthority()
  const document = readCanonicalUserConfigSnapshotSync(authority.homeContext.configTomlPath).raw
  return (document as unknown as AgenCConfig).pluginConfigs
}

function copyStoredValue(value: PluginConfigStoredValue): PluginConfigStoredValue {
  return Array.isArray(value) ? [...value] : value
}

/**
 * Resolve plugin values according to the current manifest schema.
 *
 * - Sensitive fields may come only from the native secure storage.
 * - Non-sensitive fields may come only from config.toml.
 * - Undeclared/stale fields from either store are not live configuration.
 * - Any plaintext sensitive field is rejected even when a secure-storage value exists,
 *   so an insecure duplicate cannot remain hidden on disk.
 */
export function resolveSchemaOwnedPluginConfig(
  location: string,
  schema: PluginConfigSensitivitySchema,
  configValues:
    | Readonly<Record<string, PluginConfigStoredValue>>
    | undefined,
  secureStorageValues: Readonly<Record<string, string>> | undefined,
): Record<string, PluginConfigStoredValue> {
  const plaintextSensitiveFields = Object.keys(schema).filter(
    key =>
      schema[key]?.sensitive === true &&
      configValues !== undefined &&
      Object.hasOwn(configValues, key),
  )
  if (plaintextSensitiveFields.length > 0) {
    throw new PlaintextPluginSecretError(location, plaintextSensitiveFields)
  }

  const resolved: Record<string, PluginConfigStoredValue> = {}
  for (const [key, field] of Object.entries(schema)) {
    if (field.sensitive === true) {
      if (
        secureStorageValues !== undefined &&
        Object.hasOwn(secureStorageValues, key)
      ) {
        resolved[key] = secureStorageValues[key]!
      }
      continue
    }
    if (configValues !== undefined && Object.hasOwn(configValues, key)) {
      resolved[key] = copyStoredValue(configValues[key]!)
    }
  }
  return resolved
}

/** Refuse to persist values the supplied manifest schema cannot classify. */
export function assertPluginConfigKeysDeclared(
  location: string,
  schema: PluginConfigSensitivitySchema,
  values: Readonly<Record<string, unknown>>,
): void {
  const undeclared = Object.keys(values)
    .filter(key => !Object.hasOwn(schema, key))
    .sort()
  if (undeclared.length > 0) {
    throw new Error(
      `${location} contains value(s) absent from the plugin userConfig schema: ${undeclared.join(', ')}`,
    )
  }
}

/** Replace one plugin-secret bucket without mutating or dropping other secure-storage namespaces. */
export function withPluginSecretBucket(
  current: Readonly<SecureStorageData>,
  bucketKey: string,
  values: Readonly<Record<string, string>> | undefined,
): SecureStorageData {
  const pluginSecrets = { ...(current.pluginSecrets ?? {}) }
  if (values === undefined || Object.keys(values).length === 0) {
    delete pluginSecrets[bucketKey]
  } else {
    pluginSecrets[bucketKey] = { ...values }
  }

  const next: SecureStorageData = { ...current }
  if (Object.keys(pluginSecrets).length === 0) {
    delete next.pluginSecrets
  } else {
    next.pluginSecrets = pluginSecrets
  }
  const formats = { ...(current.pluginSecretFormats ?? {}) }
  const retained = Object.fromEntries(Object.entries(formats[bucketKey] ?? {}).filter(([key]) => values !== undefined && Object.hasOwn(values, key)))
  if (Object.keys(retained).length) formats[bucketKey] = retained
  else delete formats[bucketKey]
  if (Object.keys(formats).length) next.pluginSecretFormats = formats
  else delete next.pluginSecretFormats
  return next
}

export function withPluginSecretFormats(
  current: SecureStorageData,
  bucketKey: string,
  formats: Readonly<Record<string, 'literal-v1' | 'typed-v1' | `typed-v2:${string}`>> | undefined,
): SecureStorageData {
  const all = { ...(current.pluginSecretFormats ?? {}) }
  if (formats && Object.keys(formats).length) all[bucketKey] = { ...formats }
  else delete all[bucketKey]
  if (Object.keys(all).length) current.pluginSecretFormats = all
  else delete current.pluginSecretFormats
  return current
}

function samePluginSecretBucket(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

/**
 * Roll back only the plugin-secret bucket written by a completed transaction.
 * A concurrent change to that same bucket is a conflict, never an invitation
 * to restore stale credentials over it.
 */
export function rollbackPluginSecretBucket(
  home: HomeContext,
  bucketKey: string,
  transaction: NativeSecureStorageTransaction | null,
  failureMessage: string,
): void {
  rollbackNativeSecureStorage(
    home,
    transaction,
    (current, completed) => {
      if (
        !samePluginSecretBucket(
          current.pluginSecrets?.[bucketKey],
          completed.written.pluginSecrets?.[bucketKey],
        ) || !samePluginSecretBucket(
          current.pluginSecretFormats?.[bucketKey],
          completed.written.pluginSecretFormats?.[bucketKey],
        )
      ) {
        throw new NativeSecureStorageError(
          `Plugin secret bucket ${JSON.stringify(bucketKey)} changed during rollback`,
        )
      }
      return withPluginSecretFormats(withPluginSecretBucket(
        current,
        bucketKey,
        completed.previous.pluginSecrets?.[bucketKey],
      ), bucketKey, completed.previous.pluginSecretFormats?.[bucketKey])
    },
    failureMessage,
  )
}
