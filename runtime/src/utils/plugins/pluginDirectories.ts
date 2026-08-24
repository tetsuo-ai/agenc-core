/**
 * Centralized plugin directory configuration.
 *
 * This module delegates to the single plugin-directory authority. The base
 * directory is `$AGENC_HOME/plugins` unless the session's immutable runtime
 * options supply an explicit `pluginStorageRoot` at client ingress.
 */

import { readdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage, isFsInaccessible } from '../errors.js'
import { formatFileSize } from '../format.js'
import {
  getPluginDataDir as createPluginDataDir,
  getPluginsDirectory as resolvePluginsDirectory,
  pluginDataDirPath as resolvePluginDataDirPath,
} from '../../plugins/directories.js'

/**
 * Get the full path to the plugins directory.
 *
 * Priority: session runtime option, then $AGENC_HOME/plugins.
 */
export function getPluginsDirectory(): string {
  return resolvePluginsDirectory()
}

/** Pure path — no mkdir. For display (e.g. uninstall dialog). */
export function pluginDataDirPath(pluginId: string): string {
  return resolvePluginDataDirPath(pluginId)
}

/**
 * Persistent per-plugin data directory, exposed to plugins as
 * ${AGENC_PLUGIN_DATA}. Unlike the version-scoped install cache
 * (${AGENC_PLUGIN_ROOT}, which is orphaned and GC'd on every update),
 * this survives plugin updates — only removed on last-scope uninstall.
 *
 * Creates the directory on call (mkdir). The *lazy* behavior is at the
 * substitutePluginVariables call site — the DATA pattern uses function-form
 * .replace() so this isn't invoked unless ${AGENC_PLUGIN_DATA} is present
 * (ROOT also uses function-form, but for $-pattern safety, not laziness).
 * Env-var export sites (MCP/LSP server env, hook env) call this eagerly
 * since subprocesses may expect the dir to exist before writing to it.
 *
 * Sync because it's called from substitutePluginVariables (sync, inside
 * String.replace) — making this async would cascade through 6 call sites
 * and their sync iteration loops. One mkdir in plugin-load path is cheap.
 */
export function getPluginDataDir(pluginId: string): string {
  return createPluginDataDir(pluginId)
}

/**
 * Size of the data dir for the uninstall confirmation prompt. Returns null
 * when the dir is absent or empty so callers can skip the prompt entirely.
 * Recursive walk — not hot-path (only on uninstall).
 */
export async function getPluginDataDirSize(
  pluginId: string,
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(pluginId)
  let bytes = 0
  const walk = async (p: string) => {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        // Per-entry catch: a broken symlink makes stat() throw ENOENT.
        // Without this, one broken link bubbles to the outer catch →
        // returns null → dialog skipped → data silently deleted.
        try {
          bytes += (await stat(full)).size
        } catch {
          // Broken symlink / raced delete — skip this entry, keep walking
        }
      }
    }
  }
  try {
    await walk(dir)
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
  if (bytes === 0) return null
  return { bytes, human: formatFileSize(bytes) }
}

/**
 * Best-effort cleanup on last-scope uninstall. Failure is logged but does
 * not throw — the uninstall itself already succeeded; we don't want a
 * cleanup side-effect surfacing as "uninstall failed". Same rationale as
 * deletePluginOptions (pluginOptionsStorage.ts).
 */
export async function deletePluginDataDir(pluginId: string): Promise<void> {
  const dir = pluginDataDirPath(pluginId)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    logForDebugging(
      `Failed to delete plugin data dir ${dir}: ${errorMessage(e)}`,
      { level: 'warn' },
    )
  }
}
