// Moved-source note: this moved utility still imports not-yet-absorbed upstream subsystems.
import { posix } from 'path'
// Types extracted to src/types/permissions.ts to break import cycles
import type {
  AdditionalWorkingDirectory,
  WorkingDirectorySource,
} from '../../types/permissions.js'
import { logForDebugging } from 'src/utils/debug.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import {
  persistPermissionUpdateToConfig,
  type DiskEnv,
} from '../../permissions/settings.js'
import type { EditablePermissionRuleSource } from '../../permissions/types.js'
import { toPosixPath } from './filesystem.js'
import type { PermissionRuleValue } from './PermissionRule.js'
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from './PermissionUpdateSchema.js'

// Re-export for backwards compatibility
export type { AdditionalWorkingDirectory, WorkingDirectorySource }

export function extractRules(
  updates: PermissionUpdate[] | undefined,
): PermissionRuleValue[] {
  if (!updates) return []

  return updates.flatMap(update => {
    switch (update.type) {
      case 'addRules':
        return update.rules
      default:
        return []
    }
  })
}

export function hasRules(updates: PermissionUpdate[] | undefined): boolean {
  return extractRules(updates).length > 0
}

export function supportsPersistence(
  destination: PermissionUpdateDestination,
): destination is EditablePermissionRuleSource {
  return (
    destination === 'localSettings' ||
    destination === 'userSettings' ||
    destination === 'projectSettings'
  )
}

/**
 * Persists a permission update to the appropriate settings source
 * @param update The permission update to persist
 */
export async function persistPermissionUpdate(
  update: PermissionUpdate,
  env?: DiskEnv,
): Promise<void> {
  if (update.type === 'setMode' && update.mode === 'bypassPermissions') {
    throw new Error(
      'PermissionUpdate cannot persist bypassPermissions; use the exact-cwd consent transition',
    )
  }
  if (!supportsPersistence(update.destination)) return

  logForDebugging(
    `Persisting permission update: ${update.type} to source '${update.destination}'`,
  )

  const persisted = await persistPermissionUpdateToConfig(update, env)
  if (!persisted) {
    logForDebugging(
      `Permission update was not persisted to '${update.destination}' because the canonical policy rejected it`,
      { level: 'warn' },
    )
  }
}

/**
 * Persists multiple permission updates to the appropriate settings sources
 * Only persists updates with persistable sources
 * @param updates The permission updates to persist
 */
export async function persistPermissionUpdates(
  updates: PermissionUpdate[],
  env?: DiskEnv,
): Promise<void> {
  for (const update of updates) {
    await persistPermissionUpdate(update, env)
  }
}

/**
 * Creates a Read rule suggestion for a directory.
 * @param dirPath The directory path to create a rule for
 * @param destination The destination for the permission rule (defaults to 'session')
 * @returns A PermissionUpdate for a Read rule, or undefined for the root directory
 */
export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  // Convert to POSIX format for pattern matching (handles Windows internally)
  const pathForPattern = toPosixPath(dirPath)

  // Root directory is too broad to be a reasonable permission target
  if (pathForPattern === '/') {
    return undefined
  }

  // For absolute paths, prepend an extra / to create //path/** pattern
  const ruleContent = posix.isAbsolute(pathForPattern)
    ? `/${pathForPattern}/**`
    : `${pathForPattern}/**`

  return {
    type: 'addRules',
    rules: [
      {
        toolName: FILE_READ_TOOL_NAME,
        ruleContent,
      },
    ],
    behavior: 'allow',
    destination,
  }
}
