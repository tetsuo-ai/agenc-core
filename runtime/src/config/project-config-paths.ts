/**
 * Repository-owned configuration inputs, relative to a project root.
 *
 * These are the only files a repository can use to configure AgenC. The
 * config repository reads them as the `project` and `local` layers, and the
 * project trust ledger fingerprints them so an automatic trust grant lapses
 * as soon as either file changes.
 */
export const PROJECT_CONFIG_RELATIVE_PATH = [".agenc", "config.toml"] as const;
export const LOCAL_CONFIG_RELATIVE_PATH = [".agenc", "config.local.toml"] as const;

export const REPOSITORY_CONFIG_RELATIVE_PATHS = Object.freeze([
  PROJECT_CONFIG_RELATIVE_PATH,
  LOCAL_CONFIG_RELATIVE_PATH,
] as const);
