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
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from '../log.js'
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
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
  requirePluginConfigAuthority,
  resolveSchemaOwnedPluginConfig,
  rollbackPluginSecretBucket,
  withPluginSecretBucket,
} from './pluginConfigAuthority.js'

export type PluginOptionValues = UserConfigValues
export type PluginOptionSchema = UserConfigSchema

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
): PluginOptionValues {
  const authority = requirePluginConfigAuthority()
  const configuredOptions = authority.current().pluginConfigs?.[pluginId]?.options

  const sensitive = readNativeSecureStorage(authority.homeContext)
    .pluginSecrets?.[pluginId]
  const resolved = resolveSchemaOwnedPluginConfig(
    `pluginConfigs.${JSON.stringify(pluginId)}.options`,
    schema,
    configuredOptions,
    sensitive,
  ) as PluginOptionValues
  return resolved
}

/**
 * Save option values, splitting by `schema[key].sensitive`. Non-sensitive
 * values go to config.toml; sensitive values go to native secure storage.
 * Writes are skipped when that category has no values.
 */
export async function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: PluginOptionSchema,
): Promise<void> {
  const authority = requirePluginConfigAuthority()
  assertPluginConfigKeysDeclared(
    `Plugin options for ${JSON.stringify(pluginId)}`,
    schema,
    values,
  )
  const nonSensitive: PluginOptionValues = {}
  const sensitive: Record<string, string> = {}

  for (const [key, value] of Object.entries(values)) {
    if (schema[key]?.sensitive === true) {
      sensitive[key] = String(value)
    } else {
      nonSensitive[key] = value
    }
  }

  // Scrub sets — see saveMcpServerUserConfig (mcpbHandler.ts) for the
  // rationale. Only keys in THIS save are scrubbed from the other store,
  // so partial reconfigures don't lose data.
  const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
  const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

  // Write native secure storage first. If that write fails, throw before
  // touching config.toml. Any old plaintext remains rejected until
  // reconfiguration can complete safely; it never becomes a runtime fallback.
  const secureTransaction =
    Object.keys(sensitive).length > 0 || nonSensitiveKeysInThisSave.size > 0
      ? updateNativeSecureStorage(
          authority.homeContext,
          current => {
            const existing = current.pluginSecrets?.[pluginId]
            const secureScrubbed = existing
              ? Object.fromEntries(
                  Object.entries(existing).filter(
                    ([key]) => !nonSensitiveKeysInThisSave.has(key),
                  ),
                )
              : undefined
            return withPluginSecretBucket(current, pluginId, {
              ...secureScrubbed,
              ...sensitive,
            })
          },
          `Failed to save sensitive plugin options for ${pluginId} to secure storage`,
        )
      : null

  // Write config.toml after native secure storage. Scrub sensitive keys via
  // explicit undefined (mergeWith deletion pattern).
  //
  try {
    const settings = getSettingsForSource('userSettings', authority) ?? {}
    const existingInSettings = settings.pluginConfigs?.[pluginId]?.options ?? {}
    const keysToScrubFromSettings = Object.keys(existingInSettings).filter(k =>
      sensitiveKeysInThisSave.has(k),
    )
    if (
      Object.keys(nonSensitive).length > 0 ||
      keysToScrubFromSettings.length > 0
    ) {
      const scrubbed = Object.fromEntries(
        keysToScrubFromSettings.map(k => [k, undefined]),
      ) as Record<string, undefined>
      const existingPluginConfig = settings.pluginConfigs?.[pluginId] ?? {}
      const result = await updateSettingsForSource(
        'userSettings',
        {
          pluginConfigs: {
            [pluginId]: {
              ...existingPluginConfig,
              options: {
                ...nonSensitive,
                ...scrubbed,
              } as PluginOptionValues,
            },
          },
        },
        authority,
      )
      if (result.error) {
        throw new Error(
          `Failed to save plugin options for ${pluginId}: ${result.error.message}`,
          { cause: result.error },
        )
      }
    }
  } catch (error) {
    rollbackPluginSecretBucket(
      authority.homeContext,
      pluginId,
      secureTransaction,
      `Failed to roll back sensitive plugin options for ${pluginId}`,
    )
    const errorObj = error instanceof Error ? error : new Error(String(error))
    logError(errorObj)
    throw errorObj
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
export function getUnconfiguredOptions(
  plugin: LoadedPlugin,
): PluginOptionSchema {
  const manifestSchema = plugin.manifest.userConfig
  if (!manifestSchema || Object.keys(manifestSchema).length === 0) {
    return {}
  }

  const saved = loadPluginOptions(getPluginStorageId(plugin), manifestSchema)
  const validation = validateUserConfig(saved, manifestSchema)
  if (validation.valid) {
    return {}
  }

  // Return only the fields that failed. validateUserConfig reports errors as
  // strings keyed by title/key — simpler to just re-check each field here than
  // parse error strings.
  const unconfigured: PluginOptionSchema = {}
  for (const [key, fieldSchema] of Object.entries(manifestSchema)) {
    const single = validateUserConfig(
      { [key]: saved[key] } as PluginOptionValues,
      { [key]: fieldSchema },
    )
    if (!single.valid) {
      unconfigured[key] = fieldSchema
    }
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
