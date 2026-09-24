/**
 * Plugin option storage and substitution.
 *
 * Plugins declare user-configurable options in `manifest.userConfig` — a record
 * of field schemas matching `McpbUserConfigurationOption`. At enable time the
 * user is prompted for values. Storage splits by `sensitive`:
 *   - `sensitive: true`  → native secure storage
 *   - everything else    → config.toml `pluginConfigs[pluginId].options`
 *
 * `loadPluginOptions` reads and merges both. The substitution helpers are also
 * here (moved from mcpPluginIntegration.ts) so hooks/LSP/skills don't all
 * import from MCP-specific code.
 */

import type { LoadedPlugin } from '../../types/plugin.js'
import { mutateCanonicalUserConfigSync } from '../../config/update-sync.js'
import { stableJson } from '../../config/json.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from '../log.js'
import {
  readNativeSecureStorage,
  readNativeSecureStorageFresh,
  updateNativeSecureStorage,
  NativeSecureStorageError,
  NativeSecureStorageUnavailableError,
} from '../secureStorage/native.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import {
  type UserConfigSchema,
  type UserConfigValues,
  validateUserConfig,
} from './mcpbHandler.js'
import {
  assertPluginConfigKeysDeclared,
  readFreshPluginConfigs,
  requirePluginConfigAuthority,
  resolveSchemaOwnedPluginConfig,
  rollbackPluginSecretBucket,
  withPluginSecretBucket,
  withPluginSecretFormats,
} from './pluginConfigAuthority.js'
import { decodeStoredPluginSecret, encodeStoredPluginSecret, pluginSecretFormat, type PluginSecretFormat } from './plugin-secret-codec.js'

export type PluginOptionValues = UserConfigValues
export type PluginOptionSchema = UserConfigSchema

export class PluginSettingsConflictError extends Error {
  readonly name = 'PluginSettingsConflictError'
  constructor() { super('Plugin settings changed during validation') }
}

export interface PluginSettingsValidatedSnapshot {
  readonly config: string
  readonly secure: string
}

/**
 * Canonical storage key for a plugin's options, secrets, and persistent data.
 * The loader assigns this ID once. Filesystem source and install paths are
 * provenance only and never identify durable plugin state.
 */
export function getPluginStorageId(plugin: LoadedPlugin): string {
  return plugin.id
}

/**
 * Load saved option values according to the manifest schema. Non-sensitive
 * fields come only from config.toml and sensitive fields only from the native
 * secure storage. Plaintext sensitive fields are rejected.
 *
 * Each read uses the request-owned config authority and native secure storage so one
 * daemon session can never reuse another session's option snapshot.
 */
export function loadPluginOptions(
  pluginId: string,
  schema: PluginOptionSchema,
  options: { readonly fresh?: boolean } = {},
): PluginOptionValues {
  return resolvePluginOptions(pluginId, schema, false, options.fresh === true).values
}

/** Setup reads name legacy plaintext keys but never use or return their values. */
export function inspectPluginOptions(
  pluginId: string,
  schema: PluginOptionSchema,
  options: { readonly fresh?: boolean } = {},
): { readonly values: PluginOptionValues; readonly plaintextSensitiveKeys: readonly string[] } {
  return resolvePluginOptions(pluginId, schema, true, options.fresh === true)
}

/** Resolve validation inputs from the same captured documents used at commit. */
export function inspectPluginOptionsSnapshot(
  pluginId: string,
  schema: PluginOptionSchema,
  configuredOptions: Readonly<Record<string, import('./pluginConfigAuthority.js').PluginConfigStoredValue>> | undefined,
  sensitive: Readonly<Record<string, string>> | undefined,
  formats?: Readonly<Record<string, PluginSecretFormat>>,
): { readonly values: PluginOptionValues; readonly plaintextSensitiveKeys: readonly string[] } {
  const plaintextSensitiveKeys = Object.keys(schema).filter(key =>
    schema[key]?.sensitive === true && configuredOptions !== undefined && Object.hasOwn(configuredOptions, key),
  )
  const safeOptions = configuredOptions === undefined ? undefined : Object.fromEntries(
    Object.entries(configuredOptions).filter(([key]) => !plaintextSensitiveKeys.includes(key)),
  )
  const values = resolveSchemaOwnedPluginConfig(
    `pluginConfigs.${JSON.stringify(pluginId)}.options`, schema, safeOptions, sensitive,
  ) as PluginOptionValues
  for (const [key, field] of Object.entries(schema)) {
    if (field.sensitive && typeof values[key] === 'string') values[key] = decodeStoredPluginSecret(values[key], field, formats?.[key])
  }
  return { values, plaintextSensitiveKeys }
}

function resolvePluginOptions(
  pluginId: string,
  schema: PluginOptionSchema,
  ignorePlaintext: boolean,
  fresh = false,
): { readonly values: PluginOptionValues; readonly plaintextSensitiveKeys: readonly string[] } {
  const authority = requirePluginConfigAuthority()
  const configuredOptions = (fresh ? readFreshPluginConfigs() : authority.current().pluginConfigs)?.[pluginId]?.options
  const plaintextSensitiveKeys = Object.keys(schema).filter(key =>
    schema[key]?.sensitive === true && configuredOptions !== undefined && Object.hasOwn(configuredOptions, key),
  )
  const safeOptions = ignorePlaintext && configuredOptions !== undefined
    ? Object.fromEntries(Object.entries(configuredOptions).filter(([key]) => !plaintextSensitiveKeys.includes(key)))
    : configuredOptions
  let sensitiveStorage: ReturnType<typeof readNativeSecureStorage>
  try {
    sensitiveStorage = fresh ? readNativeSecureStorageFresh(authority.homeContext) : readNativeSecureStorage(authority.homeContext)
  } catch (error) {
    if (!(fresh && error instanceof NativeSecureStorageUnavailableError)) throw error
    sensitiveStorage = {}
  }
  const sensitive = sensitiveStorage.pluginSecrets?.[pluginId]
  const resolved = resolveSchemaOwnedPluginConfig(
    `pluginConfigs.${JSON.stringify(pluginId)}.options`,
    schema,
    safeOptions,
    sensitive,
  ) as PluginOptionValues
  for (const [key, field] of Object.entries(schema)) {
    if (field.sensitive && typeof resolved[key] === 'string') resolved[key] = decodeStoredPluginSecret(resolved[key], field, sensitiveStorage.pluginSecretFormats?.[pluginId]?.[key])
  }
  return { values: resolved, plaintextSensitiveKeys }
}

/**
 * Save option values, splitting by `schema[key].sensitive`. Non-sensitive
 * values go to config.toml; sensitive values go to native secure storage.
 * The config lock encloses the secure write and optional validated-snapshot
 * check so an independent config writer cannot race validation.
 */
export async function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: PluginOptionSchema,
  expected?: PluginSettingsValidatedSnapshot,
): Promise<void> {
  const authority = requirePluginConfigAuthority()
  assertPluginConfigKeysDeclared(
    `Plugin options for ${JSON.stringify(pluginId)}`,
    schema,
    values,
  )
  const nonSensitive: PluginOptionValues = {}
  const sensitive: Record<string, string> = {}
  const sensitiveFormats: Record<string, PluginSecretFormat> = {}

  for (const [key, value] of Object.entries(values)) {
    if (schema[key]?.sensitive === true) {
      sensitive[key] = encodeStoredPluginSecret(value as string | number | boolean | string[], schema[key])
      sensitiveFormats[key] = pluginSecretFormat(value as string | number | boolean | string[], schema[key])
    } else {
      nonSensitive[key] = value
    }
  }

  // Scrub sets — see saveMcpServerUserConfig (mcpbHandler.ts) for the
  // rationale. Only keys in THIS save are scrubbed from the other store,
  // so partial reconfigures don't lose data.
  const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
  const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

  let secureTransaction: ReturnType<typeof updateNativeSecureStorage> = null
  try {
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, raw => {
      if (expected !== undefined && stableJson(raw) !== expected.config) throw new PluginSettingsConflictError()
      // The config lock encloses the secure-store comparison and write. A
      // concurrent canonical writer can no longer invalidate validation.
      try {
        secureTransaction = updateNativeSecureStorage(
          authority.homeContext,
          current => {
            if (expected !== undefined && stableJson(current) !== expected.secure) throw new PluginSettingsConflictError()
            const existing = current.pluginSecrets?.[pluginId]
            const secureScrubbed = existing
              ? Object.fromEntries(Object.entries(existing).filter(([key]) => !nonSensitiveKeysInThisSave.has(key)))
              : undefined
            const next = withPluginSecretBucket(current, pluginId, { ...secureScrubbed, ...sensitive })
            return withPluginSecretFormats(next, pluginId, { ...next.pluginSecretFormats?.[pluginId], ...sensitiveFormats })
          },
          `Failed to save sensitive plugin options for ${pluginId} to secure storage`,
        )
      } catch (error) {
        if (!(error instanceof NativeSecureStorageUnavailableError) || Object.keys(sensitive).length > 0) throw error
      }
      if (Object.keys(nonSensitive).length > 0 || sensitiveKeysInThisSave.size > 0) {
        const configs = (raw.pluginConfigs ??= {}) as Record<string, { options?: PluginOptionValues }>
        const plugin = (configs[pluginId] ??= {})
        const current = (plugin.options ??= {})
        for (const key of sensitiveKeysInThisSave) delete current[key]
        Object.assign(current, nonSensitive)
        if (Object.keys(current).length === 0) delete plugin.options
        if (Object.keys(plugin).length === 0) delete configs[pluginId]
        if (Object.keys(configs).length === 0) delete raw.pluginConfigs
      }
    })
  } catch (error) {
    try {
      rollbackPluginSecretBucket(authority.homeContext, pluginId, secureTransaction, `Failed to roll back sensitive plugin options for ${pluginId}`)
    } catch {
      throw new NativeSecureStorageError('Native secure storage rollback failed')
    }
    if (error instanceof PluginSettingsConflictError) throw error
    const safe = error instanceof NativeSecureStorageUnavailableError
      ? new NativeSecureStorageUnavailableError('Native secure storage is unavailable')
      : error instanceof NativeSecureStorageError
        ? new NativeSecureStorageError('Native secure storage operation failed')
        : new Error('Failed to save plugin options')
    logError(safe)
    throw safe
  }

}

/** Clear declared values without changing plugin enablement or MCP overrides. */
export async function resetPluginOptions(pluginId: string, keys: readonly string[]): Promise<void> {
  const authority = requirePluginConfigAuthority()
  const selected = new Set(keys)
  let transaction: ReturnType<typeof updateNativeSecureStorage> = null
  try {
    transaction = updateNativeSecureStorage(
      authority.homeContext,
      current => withPluginSecretBucket(current, pluginId, Object.fromEntries(
        Object.entries(current.pluginSecrets?.[pluginId] ?? {}).filter(([key]) => !selected.has(key)),
      )),
      `Failed to reset plugin secrets for ${pluginId}`,
    )
  } catch (error) {
    if (error instanceof NativeSecureStorageUnavailableError) throw error
    throw new NativeSecureStorageError('Native secure storage operation failed')
  }
  try {
    mutateCanonicalUserConfigSync(authority.homeContext.configTomlPath, raw => {
      const configs = raw.pluginConfigs as Record<string, { options?: Record<string, unknown> }> | undefined
      const current = configs?.[pluginId]?.options
      if (!current) return
      for (const key of selected) delete current[key]
      if (Object.keys(current).length === 0) delete configs![pluginId]!.options
      if (Object.keys(configs![pluginId]!).length === 0) delete configs![pluginId]
      if (Object.keys(configs!).length === 0) delete raw.pluginConfigs
    })
  } catch (error) {
    try { rollbackPluginSecretBucket(authority.homeContext, pluginId, transaction, `Failed to roll back plugin reset for ${pluginId}`) }
    catch { throw new NativeSecureStorageError('Native secure storage rollback failed') }
    throw new Error('Failed to reset plugin options')
  }
}

/**
 * Delete all stored option values for a plugin: both the non-sensitive
 * `settings.pluginConfigs[pluginId]` entry and the sensitive
 * `pluginSecrets[pluginId]` entry in native secure storage.
 *
 * Call this when the LAST installation of a plugin is uninstalled (i.e.,
 * alongside `markPluginVersionOrphaned`). Don't call on every uninstall —
 * a plugin can be installed in multiple scopes and the user's config should
 * survive removing it from one scope while it remains in another.
 *
 * Best-effort: a native secure storage write failure is logged but doesn't
 * throw. The uninstall itself succeeded, so we don't want to surface a confusing
 * "uninstall failed" message for a cleanup side-effect.
 */
export async function deletePluginOptions(pluginId: string): Promise<void> {
  const authority = requirePluginConfigAuthority()
  // Config side—also wipes the plugin-scoped mcpServers sub-key so uninstall
  // cannot leave an orphaned override.
  //
  // Use `undefined` (not `delete`) because the canonical patch API treats an
  // explicit undefined leaf as removal. The cast avoids adding z.undefined()
  // to the public schema, which would leak
  // `| {[k: string]: unknown}` into the public SDK type, which subsumes the
  // real object arm and kills excess-property checks for SDK consumers. The
  // deletion contract is internal plumbing and must not shape the SDK type.
  const settings = getSettingsForSource('userSettings', authority) ?? {}
  type PluginConfigs = NonNullable<typeof settings.pluginConfigs>
  if (settings.pluginConfigs?.[pluginId]) {
    // Partial<Record<K,V>> = Record<K, V | undefined> — gives us the widening
    // for the undefined value, and Partial-of-X overlaps with X so the cast
    // is a narrowing TypeScript accepts after the key-presence check above.
    const pluginConfigs: Partial<PluginConfigs> = { [pluginId]: undefined }
    const { error } = await updateSettingsForSource(
      'userSettings',
      { pluginConfigs: pluginConfigs as PluginConfigs },
      authority,
    )
    if (error) {
      logForDebugging(
        `deletePluginOptions: failed to clear settings.pluginConfigs[${pluginId}]: ${error.message}`,
        { level: 'warn' },
      )
    }
  }

  // Secure storage side — delete both the top-level pluginSecrets[pluginId]
  // and any per-server composite keys `${pluginId}/${server}` (from
  // saveMcpServerUserConfig's sensitive split). `/` prefix match is safe:
  // plugin IDs are `name@marketplace`, never contain `/`, so
  // startsWith(`${id}/`) can't false-positive on a different plugin.
  try {
    updateNativeSecureStorage(
      authority.homeContext,
      current => {
        const prefix = `${pluginId}/`
        const survivingEntries = Object.entries(current.pluginSecrets ?? {}).filter(
          ([key]) => key !== pluginId && !key.startsWith(prefix),
        )
        const next = { ...current }
        if (survivingEntries.length === 0) {
          delete next.pluginSecrets
        } else {
          next.pluginSecrets = Object.fromEntries(survivingEntries)
        }
        const survivingFormats = Object.entries(current.pluginSecretFormats ?? {}).filter(
          ([key]) => key !== pluginId && !key.startsWith(prefix),
        )
        if (survivingFormats.length === 0) delete next.pluginSecretFormats
        else next.pluginSecretFormats = Object.fromEntries(survivingFormats)
        return next
      },
      `Failed to clear plugin secrets for ${pluginId} from secure storage`,
    )
  } catch (error) {
    logForDebugging(
      `deletePluginOptions: failed to clear pluginSecrets for ${pluginId} from native secure storage: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
  }

}

/**
 * Find option keys whose saved values don't satisfy the schema — i.e., what to
 * prompt for. Returns the schema slice for those keys, or empty if everything
 * validates. Empty manifest.userConfig → empty result.
 *
 * Used by PluginOptionsFlow to decide whether to show the prompt after enable.
 */
export async function getUnconfiguredOptions(
  plugin: LoadedPlugin,
): Promise<PluginOptionSchema> {
  const manifestSchema = plugin.manifest.userConfig
  if (!manifestSchema || Object.keys(manifestSchema).length === 0) {
    return {}
  }

  const saved = loadPluginOptions(getPluginStorageId(plugin), manifestSchema)
  const effective = { ...Object.fromEntries(Object.entries(manifestSchema).filter(([, field]) => !field.sensitive && field.default !== undefined).map(([key, field]) => [key, field.default])), ...saved } as PluginOptionValues
  const validation = await validateUserConfig(effective, manifestSchema)
  if (validation.valid) {
    return {}
  }

  const unconfigured: PluginOptionSchema = {}
  for (const key of validation.invalidKeys) {
    unconfigured[key] = manifestSchema[key]!
  }
  return unconfigured
}

/**
 * Substitute ${user_config.KEY} with saved option values.
 *
 * Throws on missing keys — callers pass this only after `validateUserConfig`
 * succeeded, so a miss here means a plugin references a key it never declared
 * in its schema. That's a plugin authoring bug; failing loud surfaces it.
 *
 * Use `substituteUserConfigInContent` for skill/agent prose — it handles
 * missing keys and sensitive-filtering instead of throwing.
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: PluginOptionValues,
): string {
  return value.replace(/\$\{user_config\.([^}]+)\}/g, (_match, key) => {
    const configValue = userConfig[key]
    if (configValue === undefined) {
      throw new Error(
        `Missing required user configuration value: ${key}. ` +
          `This should have been validated before variable substitution.`,
      )
    }
    return String(configValue)
  })
}

/**
 * Content-safe variant for skill/agent prose. Differences from
 * `substituteUserConfigVariables`:
 *
 *   - Sensitive-marked keys substitute to a descriptive placeholder instead of
 *     the actual value — skill/agent content goes to the model prompt, and
 *     we don't put secrets in the model's context.
 *   - Unknown keys stay literal (no throw) — matches how `${VAR}` env refs
 *     behave today when the var is unset.
 *
 * A ref to a sensitive key produces obvious-looking output so plugin authors
 * notice and move the ref into a hook/MCP env instead.
 */
export function substituteUserConfigInContent(
  content: string,
  options: PluginOptionValues,
  schema: PluginOptionSchema,
): string {
  return content.replace(/\$\{user_config\.([^}]+)\}/g, (match, key) => {
    if (schema[key]?.sensitive === true) {
      return `[sensitive option '${key}' not available in skill content]`
    }
    const value = options[key]
    if (value === undefined) {
      return match
    }
    return String(value)
  })
}
