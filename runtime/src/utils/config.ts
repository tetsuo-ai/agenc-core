import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memory/index.js'
import * as teamMemPathsModule from '../memdir/teamMemPaths.js'
import {
  RuntimeStateRepository,
  type GlobalRuntimeState,
  type ProjectRuntimeState,
} from '../config/runtime-state-repository.js'
import type { AgenCConfig } from '../config/schema.js'
import {
  checkHasProjectTrustAcceptedSync,
  isProjectTrustedSync,
} from '../permissions/trust/project-trust.js'
import { getAgenCHomeDir, isEnvTruthy } from './envUtils.js'
import { findCanonicalGitRoot } from './git.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import {
  getManagedInstructionPath,
  getManagedInstructionRulesPath,
} from './settings/managedPath.js'
import { getCanonicalSettingsAuthority } from './settings/canonicalAuthority.js'
import { PRIMARY_PROJECT_INSTRUCTION_FILE } from './projectInstructions.js'

const teamMemPaths = feature('TEAMMEM') ? teamMemPathsModule : null
import type { ImageDimensions } from './imageResizer.js'

export {
  DEFAULT_GLOBAL_RUNTIME_STATE,
  RuntimeStateRepository,
  type GlobalRuntimeState,
  type InstallMethod,
  type ProjectRuntimeState,
} from '../config/runtime-state-repository.js'

// Image dimension info for coordinate mapping (only set when image was resized)
export type PastedContent = {
  id: number // Sequential numeric ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // e.g., 'image/png', 'image/jpeg'
  filename?: string // Display name for images in attachment slot
  dimensions?: ImageDimensions
  sourcePath?: string // Original file path for images dragged onto the terminal
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type OutputStyle = string

/**
 * Check if the user has already accepted the trust dialog for the cwd.
 *
 * This function traverses parent directories to check if a parent directory
 * had approval. Accepting trust for a directory implies trust for child
 * directories.
 *
 * @returns Whether the trust dialog has been accepted (i.e. "should not be shown")
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // Trust only transitions false→true during a session (never the reverse),
  // so once true we can latch it. false is not cached — it gets re-checked
  // on every call so that trust dialog acceptance is picked up mid-session.
  // (lodash memoize doesn't fit here because it would also cache false.)
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // Check session-level trust (for home directory case where trust is not persisted)
  // When running from home dir, trust dialog is shown but acceptance is stored
  // in memory only. This allows hooks and other features to work during the session.
  if (getSessionTrustAccepted()) {
    return true
  }

  return checkHasProjectTrustAcceptedSync({
    cwd: getOriginalCwd(),
  })
}

/**
 * Check trust for an arbitrary directory (not the session cwd).
 * Unlike checkHasTrustDialogAccepted, this does NOT consult session trust.
 * Project-root resolution and canonical path identity are owned by the
 * trusted-projects.json repository.
 */
export function isPathTrusted(dir: string): boolean {
  return isProjectTrustedSync({ cwd: resolve(dir) })
}

function requireRuntimeStateRepository(
  explicit?: RuntimeStateRepository,
): RuntimeStateRepository {
  const repository =
    explicit ?? getCanonicalSettingsAuthority()?.stateRepository
  if (!repository) {
    throw new Error(
      'Canonical settings authority is required for mutable runtime state',
    )
  }
  return repository
}

export function updateRuntimeState(
  updater: (currentConfig: GlobalRuntimeState) => GlobalRuntimeState,
  repository?: RuntimeStateRepository,
): void {
  requireRuntimeStateRepository(repository).update(updater)
}

export function getRuntimeState(
  repository?: RuntimeStateRepository,
): GlobalRuntimeState {
  return requireRuntimeStateRepository(repository).get()
}

export function getRuntimeStateNamespace(
  namespace: string,
  repository?: RuntimeStateRepository,
): Readonly<import('../config/json.js').JsonRecord> {
  return requireRuntimeStateRepository(repository).getNamespace(namespace)
}

export function updateRuntimeStateNamespace(
  namespace: string,
  updater: (
    current: Readonly<import('../config/json.js').JsonRecord>,
  ) => import('../config/json.js').JsonRecord,
  repository?: RuntimeStateRepository,
): void {
  requireRuntimeStateRepository(repository).updateNamespace(namespace, updater)
}

// Memoized function to get the project path for config lookup
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // Normalize for consistent JSON keys (forward slashes on all platforms)
    // This ensures paths like C:\Users\... and C:/Users/... map to the same key
    return normalizePathForConfigKey(gitRoot)
  }

  // Not in a git repo
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectRuntimeState(
  repository?: RuntimeStateRepository,
): ProjectRuntimeState {
  return requireRuntimeStateRepository(repository).getProject(
    getProjectPathForConfig(),
  )
}

export function saveCurrentProjectRuntimeState(
  updater: (currentState: ProjectRuntimeState) => ProjectRuntimeState,
  repository?: RuntimeStateRepository,
): void {
  requireRuntimeStateRepository(repository).updateProject(
    getProjectPathForConfig(),
    updater,
  )
}

export function isAutoUpdaterDisabled(
  config?: Pick<AgenCConfig, 'autoUpdates'>,
): boolean {
  return getAutoUpdaterDisabledReason(config) !== null
}

/**
 * Returns true if plugin autoupdate should be skipped.
 * This checks if the auto-updater is disabled AND the FORCE_AUTOUPDATE_PLUGINS
 * env var is not set to 'true'. The env var allows forcing plugin autoupdate
 * even when the auto-updater is otherwise disabled.
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(
  config?: Pick<AgenCConfig, 'autoUpdates'>,
): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const operatorConfig =
    config ?? getCanonicalSettingsAuthority()?.current()
  if (operatorConfig?.autoUpdates === false) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getRuntimeState()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  updateRuntimeState(current => ({ ...current, userID }))
  return userID
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getAgenCHomeDir(), 'AGENC.md')
    case 'Local':
      return join(cwd, 'AGENC.local.md')
    case 'Project':
      return join(cwd, PRIMARY_PROJECT_INSTRUCTION_FILE)
    case 'Managed':
      return getManagedInstructionPath()
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem is only a valid MemoryType when feature('TEAMMEM') is true
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // unreachable in external builds where TeamMem is not in MemoryType
}

export function getManagedAgenCRulesDir(): string {
  return getManagedInstructionRulesPath()
}

export function getUserAgenCRulesDir(): string {
  return join(getAgenCHomeDir(), 'rules')
}

export function _setRuntimeStateCacheForTesting(
  config: GlobalRuntimeState | null,
  repository?: RuntimeStateRepository,
): void {
  requireRuntimeStateRepository(repository).setForTesting(config ?? {})
}
