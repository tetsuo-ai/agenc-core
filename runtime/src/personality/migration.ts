/**
 * Ports upstream runtime `core/src/personality_migration.rs` onto AgenC
 * config editing, thread-store listing, and startup bootstrap primitives.
 *
 * Shape difference from upstream:
 *   - AgenC persists current config as `config.toml`; compatibility `config.json`
 *     is migrated through the existing config edit path before writing.
 *   - AgenC threads are scoped to the resolved project directory, so the
 *     caller provides the startup cwd and project-root markers.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Direct state-db handle threading; AgenC's `FileThreadStore` owns its
 *     state database connection for the startup project.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import { AgenCConfigEditsBuilder } from "../config/edit.js";
import { FileThreadStore } from "../thread-store/store.js";

export const PERSONALITY_MIGRATION_FILENAME = ".personality_migration";

export type PersonalityMigrationStatus =
  | "SkippedMarker"
  | "SkippedExplicitPersonality"
  | "SkippedNoSessions"
  | "Applied";

export interface MaybeMigratePersonalityOptions {
  readonly agencHome: string;
  readonly config: AgenCConfig;
  readonly cwd: string;
  readonly defaultModelProviderId: string;
  readonly activeProfileName?: string;
  readonly projectRootMarkers?: readonly string[];
}

export async function maybeMigratePersonality(
  opts: MaybeMigratePersonalityOptions,
): Promise<PersonalityMigrationStatus> {
  const markerPath = join(opts.agencHome, PERSONALITY_MIGRATION_FILENAME);
  if (await fileExists(markerPath)) return "SkippedMarker";

  if (hasExplicitPersonality(opts.config, opts.activeProfileName)) {
    await createMarker(markerPath);
    return "SkippedExplicitPersonality";
  }

  if (!(await hasRecordedSessions(opts))) {
    await createMarker(markerPath);
    return "SkippedNoSessions";
  }

  await new AgenCConfigEditsBuilder(opts.agencHome)
    .setPersonality("pragmatic")
    .apply();
  await createMarker(markerPath);
  return "Applied";
}

function hasExplicitPersonality(
  config: AgenCConfig,
  activeProfileName: string | undefined,
): boolean {
  if (config.personality !== undefined) return true;
  if (activeProfileName === undefined) return false;
  return config.profiles?.[activeProfileName]?.personality !== undefined;
}

async function hasRecordedSessions(
  opts: MaybeMigratePersonalityOptions,
): Promise<boolean> {
  const store = new FileThreadStore({
    cwd: opts.cwd,
    agencHome: opts.agencHome,
    defaultModelProviderId: opts.defaultModelProviderId,
    ...(opts.projectRootMarkers !== undefined
      ? { projectRootMarkers: opts.projectRootMarkers }
      : {}),
  });
  try {
    if (hasThreads(store, opts.defaultModelProviderId, false)) return true;
    return hasThreads(store, opts.defaultModelProviderId, true);
  } finally {
    store.close();
  }
}

function hasThreads(
  store: FileThreadStore,
  defaultModelProviderId: string,
  archived: boolean,
): boolean {
  return (
    store.listThreads({
      pageSize: 1,
      sortKey: "created_at",
      sortDirection: "desc",
      modelProviders: [defaultModelProviderId],
      archived,
      useStateDbOnly: false,
    }).items.length > 0
  );
}

async function createMarker(markerPath: string): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(markerPath, "v1\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
